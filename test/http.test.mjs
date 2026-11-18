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
      // No read position yet: the default listing, newest first.
      const newest = [...UNREAD].reverse();
      return [200, { data: newest, meta: { count: 2, next_cursor: null, last_read_at: ack ? UNREAD[1].created_at : null, acked: ack } }];
    }
    if (after === 'last_read' && room === 'room-wait') {
      // Unread, the newest of them a reply still being written.
      const data = [msg('w1', 5), msg('w2', 6, { is_streaming: true, content: '' })];
      return [200, { data, meta: { count: 2, next_cursor: null, last_read_at: '2026-11-18T10:04:00Z', acked: false } }];
    }
    if (after === 'last_read') {
      return [200, { data: UNREAD, meta: { count: 2, next_cursor: null, last_read_at: ack ? UNREAD[1].created_at : POSITION, acked: ack } }];
    }
    // The explicit cursor: the old shape, no read position in meta.
    return [200, { data: UNREAD, meta: { count: 2, next_cursor: null } }];
  }
  if (what === 'read' && req.method === 'POST') {
    return [200, { data: { grupr_id: room, agent_id: 'a1', last_read_at: body?.at ?? null, advanced: true } }];
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
  assert.equal(tools.length, 39, 'tool count (README says 39)');
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
  for (const want of ['grupr_room_brief_read', 'after: "last_read"', 'ack: true', 'grupr_room_brief_write', 'what is done and what is next']) {
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

  // No read position yet: the default listing, and the caller is told so.
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-new', after: 'last_read' } })));
  assert.equal(out.last_read_at, null);
  assert.deepEqual(out.messages.map((m) => m.message_id), ['m3', 'm2']);
  assert.match(out.note, /no read position in this room yet/);
  out = JSON.parse(textOf(await client.callTool({ name: 'grupr_poll_messages', arguments: { grupr_id: 'room-new', after: 'last_read', ack: true } })));
  assert.equal(out.acked, true);
  assert.match(out.note, /had no read position before this call/);

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
  assert.deepEqual(marks[0].body, { at: '2026-11-18T10:05:00Z' }, 'acknowledged through w1, not the reply still being written');
  assert.equal(out.acked, true);
  assert.equal(out.last_read_at, '2026-11-18T10:05:00Z');
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
