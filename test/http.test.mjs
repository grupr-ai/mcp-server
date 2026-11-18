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

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

// 60 s: on a busy Windows machine the server takes 13 to 25 s to load right
// after a build (measured 2026-11-18); 15 s failed the whole suite there.
async function waitFor(url, ms = 60000) {
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

// A contract as the agent hub answers it (D-171: inputs, next action, assignee).
const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const NOT_MINE_ID = '22222222-2222-4222-8222-222222222222';
const contract = {
  contract_id: CONTRACT_ID,
  title: 'Q3 summary',
  goal: 'The summary is in Room Files.',
  status: 'active',
  inputs: [
    { kind: 'file', path: 'specs/brief.md', grupr_id: '33333333-3333-4333-8333-333333333333', room: 'Ops' },
    { kind: 'file', path: 'data/q3.csv', grupr_id: '33333333-3333-4333-8333-333333333333', room: 'Ops', missing: true },
    { kind: 'note', text: 'Use the Q3 numbers.' },
  ],
  next_action: 'Read the brief.',
  next_action_at: '2026-11-18T20:00:00Z',
  assignee: { agent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Writer', handle: 'writer' },
  assigned_to_you: true,
  remaining: {},
};
const contractWrites = [];

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => resolve(raw));
  });
}

before(async () => {
  api = createServer(async (req, res) => {
    hubCalls.push({ url: req.url, auth: req.headers.authorization || '', ip: req.headers['cf-connecting-ip'] || '' });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${GOOD}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ errors: [{ code: 'unauthorized', message: 'Invalid, expired or revoked access token' }] }));
      return;
    }
    if (req.url === '/api/v1/agent-hub/contracts' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: [contract] }));
      return;
    }
    if (req.url.startsWith('/api/v1/agent-hub/contracts/') && req.method === 'PATCH') {
      const raw = await readBody(req);
      contractWrites.push({ url: req.url, type: req.headers['content-type'] || '', raw });
      if (req.url.endsWith(NOT_MINE_ID)) {
        res.writeHead(403);
        res.end(JSON.stringify({ errors: [{ code: 'contract_not_assignee', message: "Only the contract's assignee can set its next action." }] }));
        return;
      }
      const sent = JSON.parse(raw);
      res.writeHead(200);
      res.end(JSON.stringify({ data: { ...contract, next_action: sent.next_action, next_action_agent_id: contract.assignee.agent_id } }));
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

test('contract tools carry the handoff fields, and the assignee writes the next action and nothing else', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
    requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const text = (r) => r.content.map((c) => c.text).join('\n');

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'grupr_contract_next_action');
  assert.ok(tool, 'grupr_contract_next_action listed');
  assert.equal(tool.annotations?.readOnlyHint, false, 'a write tool is not read-only');
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);
  assert.ok(tool.title && tool.annotations?.title === tool.title);
  assert.deepEqual(tool.inputSchema.required, ['contract_id', 'next_action']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['contract_id', 'next_action'], 'it takes nothing but the next action');
  assert.equal(tool.inputSchema.properties.next_action.maxLength, 500);
  for (const name of ['grupr_contracts', 'grupr_contract', 'grupr_contract_traces']) {
    assert.equal(tools.find((t) => t.name === name).annotations?.readOnlyHint, true, `${name} stays read-only`);
  }

  // Reading: inputs (a missing file is marked), next action, assignee.
  const listed = JSON.parse(text(await client.callTool({ name: 'grupr_contracts', arguments: {} })));
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].inputs.map((i) => i.kind), ['file', 'file', 'note']);
  assert.equal(listed[0].inputs[1].missing, true);
  assert.equal(listed[0].next_action, 'Read the brief.');
  assert.equal(listed[0].assignee.handle, 'writer');
  assert.equal(listed[0].assigned_to_you, true);

  // Writing: one PATCH, next_action and nothing else in the body.
  const words = 'Outline drafted. Next: the numbers table.';
  const saved = await client.callTool({
    name: 'grupr_contract_next_action',
    arguments: { contract_id: CONTRACT_ID, next_action: words, status: 'cancel', title: 'smuggled' },
  });
  assert.ok(!saved.isError, text(saved));
  assert.ok(text(saved).startsWith('Next action saved.'), text(saved));
  assert.equal(JSON.parse(text(saved).split('\n').slice(1).join('\n')).next_action, words);
  assert.equal(contractWrites.length, 1);
  assert.equal(contractWrites[0].url, `/api/v1/agent-hub/contracts/${CONTRACT_ID}`);
  assert.match(contractWrites[0].type, /application\/json/);
  assert.deepEqual(JSON.parse(contractWrites[0].raw), { next_action: words }, 'only next_action is sent');

  // "" clears, and says so.
  const cleared = await client.callTool({ name: 'grupr_contract_next_action', arguments: { contract_id: CONTRACT_ID, next_action: '' } });
  assert.ok(text(cleared).startsWith('Next action cleared.'), text(cleared));
  assert.deepEqual(JSON.parse(contractWrites[1].raw), { next_action: '' });

  // A call without the words (or with something that is not text) changes
  // nothing: it must never reach the hub as "".
  for (const args of [{ contract_id: CONTRACT_ID }, { contract_id: CONTRACT_ID, next_action: 7 }, { contract_id: CONTRACT_ID, next_action: null }, { next_action: 'x' }]) {
    const r = await client.callTool({ name: 'grupr_contract_next_action', arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(contractWrites.length, 2, 'refused calls never reached the hub');

  // Not the assignee: the hub's refusal, with what to do instead.
  const refused = await client.callTool({ name: 'grupr_contract_next_action', arguments: { contract_id: NOT_MINE_ID, next_action: 'mine' } });
  assert.equal(refused.isError, true);
  assert.ok(text(refused).includes('403 contract_not_assignee'), text(refused));
  assert.ok(text(refused).includes('in the room instead'), text(refused));
  await client.close();
});
