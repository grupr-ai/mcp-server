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
// The fake hub's wake webhook (wake_on, Slack parity A1): omitted keeps what it was.
const webhookBodies = [];
let webhookWakeOn = 'all';

// ── The fake hub's rooms (read position and room brief, 0.20.0) ──
const HUB = '/api/v1/agent-hub';
const POSITION = '2026-11-18T10:00:00Z';
const msg = (id, minute, extra = {}) => ({
  message_id: id,
  grupr_id: 'room',
  sender_id: 'u1',
  content: `text of ${id}`,
  message_type: 'text',
  created_at: `2026-11-18T10:0${minute}:00Z`,
  is_streaming: false,
  ...extra,
});
const UNREAD = [msg('m2', 1), msg('m3', 2)];
let brief = null; // the brief of room-1: { content, version }

// One answer of the fake hub for the room routes; null when the path is not one.
function roomRoute(req, url, body) {
  const m = url.pathname.match(/^\/api\/v1\/agent-hub\/grups\/([^/]+)\/(messages|brief|read)$/);
  if (!m) return null;
  const [, room, what] = m;
  if (room === 'room-out') {
    return [403, { errors: [{ code: 'forbidden', message: 'Agent is not assigned to this grupr' }] }];
  }
  if (what === 'messages' && req.method === 'GET') {
    const after = url.searchParams.get('after');
    const ack = url.searchParams.get('ack') === '1';
    if (after === 'last_read' && room === 'room-new') {
      // No read position yet: the agent's first read, the newest page oldest first, flagged.
      return [
        200,
        {
          data: UNREAD,
          meta: {
            count: 2,
            next_cursor: null,
            last_read_at: ack ? UNREAD[1].created_at : null,
            last_read_message_id: ack ? UNREAD[1].message_id : null,
            acked: ack,
            first_read: true,
            earlier_available: true,
          },
        },
      ];
    }
    if (after === 'last_read' && room === 'room-wait') {
      // Unread, the newest of them a reply still being written.
      const data = [msg('w1', 5), msg('w2', 6, { is_streaming: true, content: '' })];
      return [200, { data, meta: { count: 2, next_cursor: null, last_read_at: '2026-11-18T10:04:00Z', last_read_message_id: 'w0', acked: false, first_read: false } }];
    }
    if (after === 'last_read') {
      return [
        200,
        {
          data: UNREAD,
          meta: {
            count: 2,
            next_cursor: null,
            last_read_at: ack ? UNREAD[1].created_at : POSITION,
            last_read_message_id: ack ? UNREAD[1].message_id : 'm1',
            acked: ack,
            first_read: false,
          },
        },
      ];
    }
    // The explicit cursor: the old shape, no read position in meta.
    return [200, { data: UNREAD, meta: { count: 2, next_cursor: null } }];
  }
  if (what === 'read' && req.method === 'POST') {
    // By message id, as the server sends it: the message's created_at comes back with it.
    const known = { m2: '2026-11-18T10:01:00Z', m3: '2026-11-18T10:02:00Z', w1: '2026-11-18T10:05:00Z', w2: '2026-11-18T10:06:00Z' };
    const id = body?.message_id;
    const at = id && known[id] ? known[id] : null;
    return [200, { data: { grupr_id: room, agent_id: 'a1', last_read_at: at, last_read_message_id: at ? id : null, advanced: at !== null } }];
  }
  if (what === 'brief' && req.method === 'GET') {
    const data = brief
      ? { grupr_id: room, name: 'room-brief.md', exists: true, content: brief.content, size: Buffer.byteLength(brief.content), version: brief.version, updated_at: '2026-11-18T10:09:00Z', updated_by: 'Planner', updated_by_agent: true, max_bytes: 16384 }
      : { grupr_id: room, name: 'room-brief.md', exists: false, content: '', size: 0, version: 0, max_bytes: 16384 };
    return [200, { data }];
  }
  if (what === 'brief' && req.method === 'PUT') {
    const content = body?.content ?? '';
    if (brief && brief.content === content) {
      return [200, { data: { grupr_id: room, name: 'room-brief.md', exists: true, content, size: Buffer.byteLength(content), version: brief.version, unchanged: true, max_bytes: 16384 } }];
    }
    brief = { content, version: (brief?.version ?? 0) + 1 };
    return [brief.version === 1 ? 201 : 200, { data: { grupr_id: room, name: 'room-brief.md', exists: true, content, size: Buffer.byteLength(content), version: brief.version, max_bytes: 16384 } }];
  }
  return null;
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
    requestInit: { headers: { Authorization: `Bearer ${GOOD}`, 'CF-Connecting-IP': '203.0.113.9' } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const callsTo = (path) => hubCalls.filter((c) => c.url.startsWith(HUB + path));

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
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    hubCalls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || '', ip: req.headers['cf-connecting-ip'] || '' });
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
    if (req.url === '/api/v1/agent-hub/webhooks' && req.method === 'POST') {
      webhookBodies.push({ type: req.headers['content-type'] || '', body });
      if (body?.wake_on) webhookWakeOn = body.wake_on;
      res.writeHead(200);
      // The real hub never returns auth_bearer (only auth_header); this one
      // echoes it on purpose, so the tests show the tool's reply never does.
      const bearer = body?.auth_bearer ? { auth_bearer: body.auth_bearer } : {};
      res.end(
        JSON.stringify({
          data: { webhook_id: 'wh-1', agent_id: 'agent-1', url: body?.url, is_active: true, auth_header: Boolean(body?.auth_bearer), wake_on: webhookWakeOn, ...bearer },
        }),
      );
      return;
    }
    const routed = roomRoute(req, new URL(req.url, 'http://hub.test'), body);
    if (routed) {
      res.writeHead(routed[0]);
      res.end(JSON.stringify(routed[1]));
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
      // The body was read once at the top of this mock (`raw`).
      scheduleBodies.push(JSON.parse(raw || '{}'));
      res.writeHead(202);
      res.end(JSON.stringify({ data: { status: 'pending', approval_id: 'ap-1' } }));
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
              script_hashes: [
                { path: '/home/user/jobs/r.py', sha256: '1a2b3c4d5e6f', state: 'pinned' },
                { path: '/home/user/jobs/later.py', state: 'absent' },
                { path: 'x.py', state: 'unpinned', reason: 'the shell decides which file this is' },
              ],
            },
            { schedule_id: 's3', kind: 'command', cmd: 'date', cron: '@hourly', timezone: 'UTC', grupr_id: 'g1', enabled: true, runs: 0, failures: 0, script_hashes: [] },
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

// ── Read position and room brief (0.20.0) ──

test('the two new tools are listed with honest annotations, and poll and wait are no longer read-only', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 47, 'tool count (README says 47)');
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const read = by.grupr_room_brief_read;
  assert.ok(read, 'grupr_room_brief_read listed');
  assert.equal(read.title, 'Read the room brief');
  assert.deepEqual(
    { ro: read.annotations.readOnlyHint, destructive: read.annotations.destructiveHint, open: read.annotations.openWorldHint },
    { ro: true, destructive: false, open: false },
  );
  assert.deepEqual(read.inputSchema.required, ['grupr_id']);

  // Replaces the whole brief: not read-only, may overwrite, and the same text again changes nothing.
  const write = by.grupr_room_brief_write;
  assert.ok(write, 'grupr_room_brief_write listed');
  assert.equal(write.title, 'Write the room brief');
  assert.deepEqual(
    { ro: write.annotations.readOnlyHint, destructive: write.annotations.destructiveHint, idem: write.annotations.idempotentHint, open: write.annotations.openWorldHint },
    { ro: false, destructive: true, idem: true, open: false },
  );
  assert.deepEqual(write.inputSchema.required, ['grupr_id', 'content']);
  assert.match(write.description, /16 KB/);
  assert.match(write.description, /WHOLE brief is replaced/);

  // With ack: true these move the agent's read position, so they cannot say read-only.
  for (const name of ['grupr_poll_messages', 'grupr_wait_for_messages']) {
    const t = by[name];
    assert.equal(t.annotations.readOnlyHint, false, `${name} readOnlyHint`);
    assert.equal(t.annotations.destructiveHint, false, `${name} destructiveHint`);
    assert.equal(t.inputSchema.properties.ack.type, 'boolean', `${name} takes ack`);
    assert.match(t.inputSchema.properties.after.description, /last_read/, `${name} after takes last_read`);
    assert.match(t.description, /never moves backwards/, `${name} says the position never moves backwards`);
  }
  assert.ok(tools.every((t) => t.title && t.annotations && t.annotations.title === t.title), 'every tool carries a title and annotations');

  // The resume routine, in the instructions every client is given.
  const instructions = client.getInstructions() || '';
  for (const want of ['grupr_room_brief_read', 'after: "last_read"', 'ack: true', 'grupr_room_brief_write', 'what is done and what is next', 'newest page, oldest first']) {
    assert.ok(instructions.includes(want), `instructions mention ${want}: ${instructions}`);
  }
  await client.close();
});

test('poll from the read position: after last_read and ack reach the hub, and the position comes back', async () => {
  const client = await connect();

  // Read without acknowledging: nothing moves.
  let out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-1', after: 'last_read' } })));
  assert.deepEqual(out.messages.map((m) => m.message_id), ['m2', 'm3']);
  assert.equal(out.last_read_at, POSITION);
  assert.equal(out.acked, false);
  assert.match(out.note, /Not acknowledged/);
  let call = callsTo('/grups/room-1/messages').at(-1);
  assert.equal(new URL(call.url, 'http://x').searchParams.get('after'), 'last_read');
  assert.equal(new URL(call.url, 'http://x').searchParams.get('ack'), null, 'no ack unless asked');

  // With ack: the hub is asked to move the position, and says where it is now.
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-1', after: 'last_read', ack: true, limit: 20 } })));
  assert.equal(out.acked, true);
  assert.equal(out.last_read_at, UNREAD[1].created_at);
  assert.match(out.note, /Marked read/);
  call = callsTo('/grups/room-1/messages').at(-1);
  const q = new URL(call.url, 'http://x').searchParams;
  assert.deepEqual([q.get('after'), q.get('ack'), q.get('limit')], ['last_read', '1', '20']);

  // No read position yet: the first read, the newest page oldest first, said so, with what the api reports.
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-new', after: 'last_read' } })));
  assert.equal(out.last_read_at, null);
  assert.equal(out.last_read_message_id, null);
  assert.equal(out.first_read, true);
  assert.equal(out.earlier_available, true);
  assert.deepEqual(out.messages.map((m) => m.message_id), ['m2', 'm3'], 'oldest first, as the api sends them');
  assert.match(out.note, /first read of this room/);
  assert.match(out.note, /Older messages exist/);
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-new', after: 'last_read', ack: true } })));
  assert.equal(out.acked, true);
  assert.equal(out.first_read, true);
  assert.equal(out.last_read_message_id, 'm3');
  assert.match(out.note, /first read of this room/);
  assert.match(out.note, /Marked read/);
  // A positioned read is not a first read, and carries both halves of the position.
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-1', after: 'last_read' } })));
  assert.equal(out.first_read, false);
  assert.equal(out.last_read_message_id, 'm1');
  assert.equal(out.earlier_available, undefined);

  // The explicit cursor is what it was: same call to the hub, same answer shape.
  const before = hubCalls.length;
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-1', after: POSITION } })));
  assert.deepEqual(Object.keys(out).sort(), ['count', 'messages', 'next_cursor']);
  assert.equal(out.count, 2);
  assert.equal(hubCalls.length, before + 1);
  const plain = new URL(hubCalls.at(-1).url, 'http://x').searchParams;
  assert.equal(plain.get('after'), POSITION);
  assert.equal(plain.get('ack'), null);

  // A room the agent is not in: the hub's refusal, as an error.
  const refused = await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-out', after: 'last_read', ack: true } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /403 forbidden/);
  await client.close();
});

test('wait from the read position returns what is unread at once, and ack stops before a reply still being written', async () => {
  const client = await connect();
  const started = Date.now();
  const out = JSON.parse(
    textOf(await client.callTool({ name: 'grupr_wait_for_messages', arguments: { grupr_id: 'room-wait', after: 'last_read', ack: true, timeout_seconds: 30 } })),
  );
  assert.ok(Date.now() - started < 5000, 'unread messages return without waiting');
  assert.equal(out.reason, 'message');
  assert.deepEqual(out.messages.map((m) => m.message_id), ['w1', 'w2']);
  // The first read does not acknowledge: only what was returned is, and only up to the finished message.
  const poll = callsTo('/grups/room-wait/messages').at(-1);
  assert.equal(new URL(poll.url, 'http://x').searchParams.get('ack'), null);
  const marks = callsTo('/grups/room-wait/read');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].method, 'POST');
  assert.deepEqual(marks[0].body, { message_id: 'w1' }, 'acknowledged through w1 (by id, the exact place in the order), not the reply still being written');
  assert.equal(out.acked, true);
  assert.equal(out.last_read_at, '2026-11-18T10:05:00Z');
  assert.equal(out.last_read_message_id, 'w1');
  assert.equal(out.first_read, false);
  await client.close();
});

test('the room brief: read, write, the 16 KB cap, and a room the agent is not in', async () => {
  const client = await connect();
  brief = null;

  let text = textOf(await client.callTool({ name: 'grupr_room_brief_read', arguments: { grupr_id: 'room-1' } }));
  assert.match(text, /no brief yet/);

  const content = '# Brief\n\nDone: the draft.\nNext: review it.\n';
  text = textOf(await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content } }));
  assert.match(text, /Brief saved: version 1/);
  const put = callsTo('/grups/room-1/brief').filter((c) => c.method === 'PUT').at(-1);
  assert.deepEqual(put.body, { content }, 'the whole brief went to the hub as JSON');

  text = textOf(await client.callTool({ name: 'grupr_room_brief_read', arguments: { grupr_id: 'room-1' } }));
  assert.ok(text.startsWith('room-brief.md, version 1'), text);
  assert.ok(text.includes('by Planner (agent)'), text);
  assert.ok(text.endsWith(content), text);

  text = textOf(await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content } }));
  assert.match(text, /nothing changed/);

  // Over the cap, or empty: refused here, and the hub is never asked.
  const puts = callsTo('/grups/room-1/brief').filter((c) => c.method === 'PUT').length;
  const big = await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content: 'a'.repeat(16 * 1024 + 1) } });
  assert.equal(big.isError, true);
  assert.match(textOf(big), /16385 bytes; the cap is 16384/);
  // The cap is bytes: 6,000 three-byte characters are 18,000 bytes.
  const wide = await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content: '\u20ac'.repeat(6000) } });
  assert.equal(wide.isError, true);
  assert.match(textOf(wide), /18000 bytes/);
  const empty = await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content: '  \n' } });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /content is required/);
  assert.equal(callsTo('/grups/room-1/brief').filter((c) => c.method === 'PUT').length, puts, 'refused writes never reached the hub');
  const exact = await client.callTool({ name: 'grupr_room_brief_write', arguments: { grupr_id: 'room-1', content: 'a'.repeat(16 * 1024) } });
  assert.notEqual(exact.isError, true, 'exactly 16 KB is allowed: ' + textOf(exact));

  // A room the agent is not assigned to: the hub refuses, and that is what the caller sees.
  for (const [name, args] of [
    ['grupr_room_brief_read', { grupr_id: 'room-out' }],
    ['grupr_room_brief_write', { grupr_id: 'room-out', content: '# Brief' }],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /403 forbidden/, name);
  }
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
  assert.ok(listed.includes('· pinned jobs/r.py (1a2b3c4d); absent now: jobs/later.py; not pinned: x.py (the shell decides which file this is)'), listed);
  assert.ok(listed.includes('- s3 · `date` · @hourly UTC') && listed.includes('· Grupr cannot detect later changes to what this command runs'), listed);
  assert.match(sched.description, /recorded as absent/);

  const runs = text(await client.callTool({ name: 'grupr_workspace_schedule_runs', arguments: { schedule_id: 's1' } }));
  assert.ok(runs.includes('· not delivered · No anthropic API key configured.'), runs);
  assert.ok(runs.includes('· instruction posted · Instruction posted in the room for @op.'), runs);
  await client.close();
});

test('grupr_register_webhook sends wake_on ("only when @mentioned or replied to") and leaves it out when not given', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const reg = tools.find((t) => t.name === 'grupr_register_webhook');
  assert.deepEqual(reg.inputSchema.properties.wake_on.enum, ['all', 'mentions']);
  assert.deepEqual(reg.inputSchema.required, ['url']);
  const text = (r) => r.content.map((c) => c.text).join('\n');

  const on = await client.callTool({
    name: 'grupr_register_webhook',
    arguments: { url: 'https://hook.test/a', secret: 's3', wake_on: 'mentions' },
  });
  assert.notEqual(on.isError, true, text(on));
  assert.deepEqual(webhookBodies.at(-1), {
    type: 'application/json',
    body: { url: 'https://hook.test/a', secret: 's3', wake_on: 'mentions' },
  });
  assert.match(text(on), /^Webhook registered\. webhook_id=wh-1 active=true wake_on=mentions: it is called for only posts that @mention this agent/);

  // Left out: not sent, so the hub keeps "mentions".
  const kept = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'https://hook.test/a' } });
  assert.deepEqual(webhookBodies.at(-1).body, { url: 'https://hook.test/a', secret: '' });
  assert.match(text(kept), /wake_on=mentions/);

  const all = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'https://hook.test/a', wake_on: 'all' } });
  assert.equal(webhookBodies.at(-1).body.wake_on, 'all');
  assert.match(text(all), /wake_on=all: it is called for every post/);

  // A value the api does not take is refused here, and the hub is not called.
  const sent = webhookBodies.length;
  const bad = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'https://hook.test/a', wake_on: 'replies' } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /wake_on must be "all" or "mentions"/);
  const noURL = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: '  ', wake_on: 'mentions' } });
  assert.equal(noURL.isError, true);
  assert.equal(webhookBodies.length, sent, 'refused calls never reached the hub');
  await client.close();
});

test('grupr_register_webhook sends auth_bearer in the body, never echoes it, and refuses it with an http url', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const reg = tools.find((t) => t.name === 'grupr_register_webhook');
  assert.equal(reg.inputSchema.properties.auth_bearer.type, 'string');
  assert.deepEqual(reg.inputSchema.required, ['url']);
  const text = (r) => r.content.map((c) => c.text).join('\n');
  const BEARER = 'bearer-' + 'q'.repeat(48);

  const set = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'https://hook.test/b', auth_bearer: BEARER } });
  assert.notEqual(set.isError, true, text(set));
  assert.deepEqual(webhookBodies.at(-1).body, { url: 'https://hook.test/b', secret: '', auth_bearer: BEARER });
  assert.match(text(set), /auth_header=true: every delivery carries your bearer/);
  assert.ok(!text(set).includes(BEARER), 'the reply never shows the bearer, even when the hub echoed it');

  // Left out: not sent (the hub then clears it, as registering again always did).
  await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'https://hook.test/b' } });
  assert.equal('auth_bearer' in webhookBodies.at(-1).body, false);

  // Over cleartext: refused here, and the bearer never leaves this server.
  const sent = webhookBodies.length;
  const plain = await client.callTool({ name: 'grupr_register_webhook', arguments: { url: 'http://hook.test/b', auth_bearer: BEARER } });
  assert.equal(plain.isError, true);
  assert.match(text(plain), /auth_bearer requires an https:\/\/ url/);
  assert.ok(!text(plain).includes(BEARER));
  assert.equal(webhookBodies.length, sent, 'the refused call never reached the hub');
  await client.close();
});
