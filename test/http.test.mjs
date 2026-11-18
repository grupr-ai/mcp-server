// The hosted connector, end to end against a fake agent hub: the 401
// handshake that starts OAuth, the resource metadata, a dead token refused,
// and a real MCP client (the SDK's Streamable HTTP client) listing tools with
// their annotations and calling one as the bearer it holds, with the end
// user's IP forwarded to the hub. Run: npm test (builds first).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOOD = 'goa_' + 'a'.repeat(64);
const ISSUER = 'https://api.test';

let api;
let apiPort;
let child;
let mcpURL;
const hubCalls = [];
const scheduleBodies = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

async function waitFor(url, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not come up: ' + url);
}

before(async () => {
  api = createServer((req, res) => {
    hubCalls.push({ url: req.url, auth: req.headers.authorization || '', ip: req.headers['cf-connecting-ip'] || '' });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${GOOD}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ errors: [{ code: 'unauthorized', message: 'Invalid, expired or revoked access token' }] }));
      return;
    }
    if (req.url.startsWith('/api/v1/agent-hub/workspace/summary')) {
      res.writeHead(404);
      res.end(JSON.stringify({ errors: [{ code: 'not_found', message: 'no workspace' }] }));
      return;
    }
    if (req.url === '/api/v1/agent-hub/workspace') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: { status: 'paused', seen_ip: req.headers['cf-connecting-ip'] || '' } }));
      return;
    }
    // Routines: a proposal is recorded as the hub received it and answered
    // "pending"; the listing has one routine of each kind.
    if (req.method === 'POST' && req.url === '/api/v1/agent-hub/workspace/schedule') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        scheduleBodies.push(JSON.parse(raw || '{}'));
        res.writeHead(202);
        res.end(JSON.stringify({ data: { status: 'pending', approval_id: 'ap-1' } }));
      });
      return;
    }
    if (req.url === '/api/v1/agent-hub/workspace/schedules') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          data: [
            { schedule_id: 's1', kind: 'prompt', prompt: 'Write the\nmorning brief.', cmd: '', cron: '0 8 * * 1-5', timezone: 'UTC', grupr_id: 'g1', enabled: true, runs: 2, failures: 0 },
            {
              schedule_id: 's2', kind: 'command', cmd: 'python3 jobs/r.py', cron: '0 0 * * *', timezone: 'UTC', grupr_id: 'g1', enabled: false,
              paused_reason: 'script_changed', paused_detail: 'jobs/r.py', last_status: 'blocked', runs: 3, failures: 0,
            },
          ],
        }),
      );
      return;
    }
    if (req.url.startsWith('/api/v1/agent-hub/workspace/schedules/s1/runs')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          data: [
            { run_id: 'r2', source: 'prompt', status: 'failed', error: 'No anthropic API key configured.', created_at: '2026-11-19T13:00:00Z' },
            { run_id: 'r1', source: 'prompt', status: 'done', stdout: 'Instruction posted in the room for @op.', created_at: '2026-11-18T13:00:00Z' },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  apiPort = await listen(api);
  const port = await freePort();
  child = spawn(process.execPath, [join(here, '..', 'dist', 'http.js')], {
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_HOST: '127.0.0.1',
      MCP_PUBLIC_URL: ISSUER,
      GRUPR_BASE_URL: `http://127.0.0.1:${apiPort}/api/v1/agent-hub`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d));
  mcpURL = `http://127.0.0.1:${port}/mcp`;
  await waitFor(mcpURL + '/health');
});

after(async () => {
  child?.kill();
  if (child) await once(child, 'exit').catch(() => {});
  await new Promise((r) => api.close(r));
});

test('no bearer: 401 that points at the resource metadata', async () => {
  const r = await fetch(mcpURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const www = r.headers.get('www-authenticate') || '';
  assert.match(www, /^Bearer /);
  assert.ok(www.includes(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`), www);
  assert.equal(hubCalls.length, 0, 'nothing was asked of the hub');
});

test('resource metadata names the api as the authorization server', async () => {
  const r = await fetch(`http://127.0.0.1:${new URL(mcpURL).port}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.equal(doc.resource, `${ISSUER}/mcp`);
  assert.deepEqual(doc.authorization_servers, [ISSUER]);
});

test('a dead token is refused with invalid_token before any MCP work', async () => {
  const r = await fetch(mcpURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer goa_' + 'b'.repeat(64) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(r.status, 401);
  assert.ok((r.headers.get('www-authenticate') || '').includes('error="invalid_token"'));
});

test('an MCP client lists annotated tools and calls one as its bearer', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
    requestInit: { headers: { Authorization: `Bearer ${GOOD}`, 'CF-Connecting-IP': '203.0.113.9' } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const info = tools.find((t) => t.name === 'grupr_workspace_info');
  assert.ok(info, 'grupr_workspace_info listed');
  assert.equal(info.title, 'Workspace status');
  assert.equal(info.annotations?.readOnlyHint, true);
  const send = tools.find((t) => t.name === 'grupr_send_message');
  assert.equal(send.annotations?.readOnlyHint, false);
  assert.equal(send.annotations?.destructiveHint, false);
  assert.ok(tools.every((t) => t.title && t.annotations), 'every tool carries a title and annotations');

  const result = await client.callTool({ name: 'grupr_workspace_info', arguments: {} });
  const text = result.content.map((c) => c.text).join('\n');
  assert.ok(text.includes('paused'), text);
  assert.ok(text.includes('203.0.113.9'), 'the end user IP reached the hub: ' + text);
  const call = hubCalls.find((c) => c.url === '/api/v1/agent-hub/workspace');
  assert.ok(call && call.auth === `Bearer ${GOOD}`, 'the hub saw the bearer of the request');
  await client.close();
});

test('a prompt routine is proposed with an instruction and no command, and listed as one', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
    requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const text = (r) => r.content.map((c) => c.text).join('\n');

  // The tool takes either kind: cmd is no longer required, and the text says
  // what a prompt routine does and that a changed script pauses a command one.
  const { tools } = await client.listTools();
  const sched = tools.find((t) => t.name === 'grupr_workspace_schedule');
  assert.deepEqual(sched.inputSchema.required, ['grupr_id', 'cron']);
  assert.deepEqual(sched.inputSchema.properties.kind.enum, ['command', 'prompt']);
  assert.ok(sched.inputSchema.properties.prompt, 'prompt is a parameter');
  assert.match(sched.description, /no sandbox time/);
  assert.match(sched.description, /pauses until the owner re-approves/);
  assert.equal(sched.annotations?.readOnlyHint, false);

  const proposed = await client.callTool({
    name: 'grupr_workspace_schedule',
    arguments: { grupr_id: 'g1', kind: 'prompt', prompt: 'Write the morning brief.', cron: '0 8 * * 1-5', timezone: 'America/New_York', label: 'Brief' },
  });
  assert.match(text(proposed), /^Prompt routine proposed — approval ap-1 is waiting/);
  assert.match(text(proposed), /no workspace is used/);
  assert.deepEqual(scheduleBodies.at(-1), {
    grupr_id: 'g1',
    kind: 'prompt',
    prompt: 'Write the morning brief.',
    cron: '0 8 * * 1-5',
    timezone: 'America/New_York',
    label: 'Brief',
  });

  // With no kind, an instruction alone is a prompt routine and a command alone
  // a command routine; a blank cmd is not sent as a command.
  await client.callTool({ name: 'grupr_workspace_schedule', arguments: { grupr_id: 'g1', prompt: 'Check the inbox.', cmd: '  ', cron: '@daily' } });
  assert.deepEqual(scheduleBodies.at(-1), { grupr_id: 'g1', kind: 'prompt', prompt: 'Check the inbox.', cron: '@daily' });
  const command = await client.callTool({ name: 'grupr_workspace_schedule', arguments: { grupr_id: 'g1', cmd: 'python3 jobs/r.py', cron: '@daily', notify: 'failures' } });
  assert.deepEqual(scheduleBodies.at(-1), { grupr_id: 'g1', kind: 'command', cmd: 'python3 jobs/r.py', cron: '@daily', notify: 'failures' });
  assert.match(text(command), /^Routine proposed — approval ap-1/);
  assert.doesNotMatch(text(command), /no workspace is used/);

  const listed = text(await client.callTool({ name: 'grupr_workspace_schedules', arguments: {} }));
  assert.ok(listed.includes('- s1 · instruction "Write the morning brief." · 0 8 * * 1-5 UTC'), listed);
  assert.ok(listed.includes('- s2 · `python3 jobs/r.py`'), listed);
  assert.ok(listed.includes('PAUSED: `jobs/r.py` changed since the routine was approved, so nothing runs until the owner re-approves it'), listed);

  const runs = text(await client.callTool({ name: 'grupr_workspace_schedule_runs', arguments: { schedule_id: 's1' } }));
  assert.ok(runs.includes('· not delivered · No anthropic API key configured.'), runs);
  assert.ok(runs.includes('· instruction posted · Instruction posted in the room for @op.'), runs);
  await client.close();
});
