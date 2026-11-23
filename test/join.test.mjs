// Join a room by invite link (Slack parity A3): grupr_join_room and
// grupr_join_request against a fake agent hub. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOIN_TOOLS, MAX_JOIN_WAIT_SECONDS, callJoinTool, describeJoinRequest, isJoinTool } from '../dist/join.js';

const ID = '3b9d2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';
const ROOM = '9c8b7a6d-1111-4c6e-8f90-a1b2c3d4e5f6';
const LINK = 'https://app.grupr.ai/join/agent#gja_' + 'A'.repeat(43);

function fakeHub(responses) {
  const calls = [];
  const hubJSON = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { hubJSON, calls };
}

test('both tools are listed with a title and honest annotations', () => {
  const names = JOIN_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['grupr_join_room', 'grupr_join_request']);
  for (const t of JOIN_TOOLS) {
    assert.ok(isJoinTool(t.name));
    assert.ok(t.title && t.annotations.title === t.title, `${t.name} title`);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.openWorldHint, false);
  }
  const [join, check] = JOIN_TOOLS;
  assert.equal(join.annotations.readOnlyHint, false);
  assert.equal(join.annotations.idempotentHint, true, 'the same link again changes nothing');
  assert.deepEqual(join.inputSchema.required, ['link']);
  assert.equal(check.annotations.readOnlyHint, true);
  assert.ok(!isJoinTool('grupr_rooms'));
});

test('grupr_join_room sends the link and says it joined', async () => {
  const { hubJSON, calls } = fakeHub([{ result: 'joined', room: { id: ROOM, name: 'Ops' } }]);
  const res = await callJoinTool('grupr_join_room', { link: `  ${LINK} ` }, hubJSON);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/join');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { code: LINK });
  const text = res.content[0].text;
  assert.ok(text.startsWith('Joined "Ops"'), text);
  assert.ok(text.includes(ROOM) && text.includes('owner is a member'), text);
});

test('grupr_join_room takes a code, and reports a request and an existing membership', async () => {
  const { hubJSON, calls } = fakeHub([
    { result: 'request_sent', room: { id: ROOM, name: 'Ops' }, request: { id: ID, status: 'pending', room_id: ROOM, room_name: 'Ops', expires_at: '2026-11-30T12:00:00Z' } },
    { result: 'already_joined', room: { id: ROOM, name: 'Ops' } },
  ]);
  const sent = await callJoinTool('grupr_join_room', { code: 'gja_' + 'B'.repeat(43) }, hubJSON);
  assert.deepEqual(calls[0].body, { code: 'gja_' + 'B'.repeat(43) });
  assert.ok(sent.content[0].text.includes(`request_id ${ID}: pending`), sent.content[0].text);
  assert.ok(sent.content[0].text.includes('grupr_join_request'), sent.content[0].text);
  const again = await callJoinTool('grupr_join_room', { link: LINK }, hubJSON);
  assert.ok(again.content[0].text.includes('already in'), again.content[0].text);
});

test('a refusal from the hub propagates to the server handler', async () => {
  const err = new Error('This invite link has expired.');
  const { hubJSON } = fakeHub([err]);
  await assert.rejects(() => callJoinTool('grupr_join_room', { link: LINK }, hubJSON), err);
});

test('grupr_join_request reads once by default, and lists without an id', async () => {
  const { hubJSON, calls } = fakeHub([
    { request: { id: ID, status: 'approved', room_id: ROOM, room_name: 'Ops' } },
    { requests: [{ id: ID, status: 'denied', room_id: ROOM }] },
    { requests: [] },
  ]);
  const one = await callJoinTool('grupr_join_request', { request_id: ID }, hubJSON);
  assert.equal(calls[0].path, `/join-requests/${ID}`);
  assert.ok(one.content[0].text.includes('approved'), one.content[0].text);
  const list = await callJoinTool('grupr_join_request', {}, hubJSON);
  assert.equal(calls[1].path, '/join-requests');
  assert.ok(list.content[0].text.includes('denied'));
  const none = await callJoinTool('grupr_join_request', {}, hubJSON);
  assert.ok(none.content[0].text.includes('no join requests'));
});

test('grupr_join_request waits for the decision, capped at 50 seconds', async () => {
  const { hubJSON, calls } = fakeHub([
    { request: { id: ID, status: 'pending', room_id: ROOM } },
    { request: { id: ID, status: 'pending', room_id: ROOM } },
    { request: { id: ID, status: 'approved', room_id: ROOM } },
  ]);
  const res = await callJoinTool('grupr_join_request', { request_id: ID, wait_seconds: 5 }, hubJSON, { pollMs: 10 });
  assert.equal(calls.length, 3);
  assert.ok(res.content[0].text.includes('approved'));
  assert.equal(MAX_JOIN_WAIT_SECONDS, 50);
});

test('every status reads as a next step', () => {
  for (const [status, words] of [
    ['pending', 'Waiting'],
    ['approved', 'You are in'],
    ['denied', 'said no'],
    ['expired', 'Nobody decided'],
  ]) {
    assert.ok(describeJoinRequest({ id: ID, status, room_id: ROOM }).includes(words), status);
  }
});
