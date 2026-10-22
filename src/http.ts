#!/usr/bin/env node
/**
 * Grupr MCP Server — Streamable HTTP entry: the hosted connector.
 *
 * Serves MCP at MCP_PATH (default /mcp) for remote clients: Claude.ai and
 * Claude Desktop connectors, ChatGPT, Cursor's remote servers, anything that
 * speaks Streamable HTTP. There is no shared secret here. Every request
 * carries its own bearer, normally a goa_ OAuth access token the client got
 * by sending the owner through api.grupr.ai/oauth/authorize (a gat_ agent
 * token works too), and the api decides what it may do.
 *
 * A request without a usable bearer gets 401 with
 *   WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/mcp"
 * which is how an MCP client discovers the authorization server and starts
 * OAuth (RFC 9728). Behind Caddy on api.grupr.ai only /mcp* reaches this
 * process; the discovery documents and the OAuth endpoints are the api's.
 * The documents are served here too for standalone deployments.
 *
 * Stateless: a fresh Server + transport per request, plain JSON responses
 * (no SSE), no sessions to lose on restart. Tool calls that wait (
 * grupr_wait_for_messages) hold the request open; GRUPR_MAX_WAIT_SECONDS caps
 * that below the proxy's cut-off.
 *
 * Environment:
 *   MCP_PORT                 default 8787
 *   MCP_HOST                 default 0.0.0.0
 *   MCP_PATH                 default /mcp
 *   MCP_PUBLIC_URL           the issuer: the public origin of the api that
 *                            fronts this process (https://api.grupr.ai)
 *   GRUPR_BASE_URL           the agent-hub base this process calls
 *                            (http://api:3000/api/v1/agent-hub inside compose)
 *   GRUPR_MAX_WAIT_SECONDS   see server.ts
 */

import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BASE_URL, SERVER_VERSION, createServer, newSession, runWithSession } from './server.js';

const PORT = Number(process.env.MCP_PORT ?? 8787);
const HOST = process.env.MCP_HOST || '0.0.0.0';
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || 'https://api.grupr.ai').replace(/\/+$/, '');
const RESOURCE = PUBLIC_URL + MCP_PATH;
const RESOURCE_METADATA = PUBLIC_URL + '/.well-known/oauth-protected-resource' + MCP_PATH;
const MAX_BODY = 1 << 20;

// ── Bearer check ────────────────────────────────────────
//
// The api is the authority on every token; this process only needs to know
// early whether the bearer is usable, so that a dead one gets the 401 that
// makes the client re-authorize instead of an initialize that succeeds and
// tool calls that all fail. One cheap authenticated read, remembered a
// minute per token (hashed), five seconds for a refusal.

const verdicts = new Map<string, { ok: boolean; until: number }>();

async function tokenUsable(token: string, headers: Record<string, string>): Promise<boolean> {
  const key = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const hit = verdicts.get(key);
  if (hit && hit.until > now) return hit.ok;
  let ok: boolean;
  try {
    const res = await fetch(`${BASE_URL}/workspace/summary`, {
      headers: { ...headers, Authorization: `Bearer ${token}`, 'User-Agent': `grupr-mcp-server/${SERVER_VERSION}` },
      signal: AbortSignal.timeout(8000),
    });
    // Anything but a refusal means the api accepted the credential (a 404 is
    // an agent with no workspace yet; a 429 is the rate limit, not the token).
    ok = res.status !== 401 && res.status !== 403;
  } catch {
    // The api is unreachable: keep the last verdict if there is one. The
    // tool call itself will report the outage in words.
    return hit?.ok ?? false;
  }
  if (verdicts.size > 20000) verdicts.clear();
  verdicts.set(key, { ok, until: now + (ok ? 60_000 : 5_000) });
  return ok;
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization || '';
  const [scheme, value] = h.split(' ', 2);
  if (!value || scheme.toLowerCase() !== 'bearer') return '';
  return value.trim();
}

/** The end user's address as the edge saw it, for the api's per-IP limits. */
function clientHeaders(req: IncomingMessage): Record<string, string> {
  const cf = req.headers['cf-connecting-ip'];
  const xff = req.headers['x-forwarded-for'];
  const ip =
    (typeof cf === 'string' && cf.trim()) ||
    (typeof xff === 'string' && xff.split(',')[0].trim()) ||
    req.socket.remoteAddress ||
    '';
  return ip ? { 'CF-Connecting-IP': ip } : {};
}

// ── Responses ───────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse, error?: string, description?: string): void {
  let challenge = `Bearer realm="grupr", resource_metadata="${RESOURCE_METADATA}"`;
  if (error) challenge += `, error="${error}"`;
  if (description) challenge += `, error_description="${description}"`;
  json(res, 401, { error: error || 'unauthorized', error_description: description || 'A bearer token is required. Sign in with Grupr to get one.' }, { 'WWW-Authenticate': challenge });
}

function protectedResource(): unknown {
  return {
    resource: RESOURCE,
    authorization_servers: [PUBLIC_URL],
    scopes_supported: ['agent'],
    bearer_methods_supported: ['header'],
    resource_name: 'Grupr',
    resource_documentation: 'https://docs.grupr.ai/mcp',
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── The server ──────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === MCP_PATH + '/health') {
    json(res, 200, { ok: true, version: SERVER_VERSION, resource: RESOURCE });
    return;
  }
  if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource' + MCP_PATH) {
    json(res, 200, protectedResource(), { 'Cache-Control': 'public, max-age=300' });
    return;
  }
  if (url.pathname !== MCP_PATH) {
    json(res, 404, { error: 'not_found', error_description: `MCP is served at ${RESOURCE}` });
    return;
  }

  const token = bearer(req);
  if (!token) {
    unauthorized(res);
    return;
  }
  const headers = clientHeaders(req);
  if (!(await tokenUsable(token, headers))) {
    unauthorized(res, 'invalid_token', 'The access token is invalid, expired or revoked');
    return;
  }

  let body: unknown;
  if (req.method === 'POST') {
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: 'invalid_request', error_description: err instanceof Error ? err.message : 'bad body' });
      return;
    }
  }

  const mcp = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await runWithSession(newSession(token, headers), () => transport.handleRequest(req, res, body));
}

const server = createHttpServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('mcp request failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: 'The MCP server hit an unexpected error' });
    else res.end();
  });
});
// A waiting tool call holds the request open for up to GRUPR_MAX_WAIT_SECONDS;
// give the socket room beyond that.
server.requestTimeout = 330_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 75_000;

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.error(`Grupr MCP server ${SERVER_VERSION} listening on http://${HOST}:${port}${MCP_PATH} (resource ${RESOURCE}; hub ${BASE_URL})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
