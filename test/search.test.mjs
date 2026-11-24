// Search messages (Slack parity B1): grupr_search_messages against a fake
// agent hub. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_TOOLS, callSearchTool, describeHit, isSearchTool, markedSnippet, searchQuery } from '../dist/search.js';

const ROOM = '9c8b7a6d-1111-4c6e-8f90-a1b2c3d4e5f6';
const USER = '3b9d2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';
const AGENT = '7a1d2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';

function fakeHub(responses) {
  const calls = [];
  const hubEnvelope = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { hubEnvelope, calls };
}

test('the tool is listed with a title and read-only annotations', () => {
  assert.deepEqual(SEARCH_TOOLS.map((t) => t.name), ['grupr_search_messages']);
  const [t] = SEARCH_TOOLS;
  assert.ok(isSearchTool(t.name));
  assert.ok(!isSearchTool('grupr_poll_messages'));
  assert.equal(t.title, 'Search messages');
  assert.equal(t.annotations.title, t.title);
  assert.deepEqual(
    { ro: t.annotations.readOnlyHint, d: t.annotations.destructiveHint, i: t.annotations.idempotentHint, o: t.annotations.openWorldHint },
    { ro: true, d: false, i: true, o: false },
  );
  assert.deepEqual(t.inputSchema.required, ['query']);
  assert.match(t.description, /withheld/);
});

test('arguments become the hub query string, and only the ones given', () => {
  const qs = new URLSearchParams(
    searchQuery({ query: '  deploy "plan b" -old ', room_id: ROOM, from_agent_id: AGENT, after: '2026-11-01', before: '2026-11-03', has_file: true, limit: 99, cursor: 'abc' }),
  );
  assert.equal(qs.get('q'), 'deploy "plan b" -old');
  assert.equal(qs.get('room'), ROOM);
  assert.equal(qs.get('from_agent'), AGENT);
  assert.equal(qs.get('from_user'), null);
  assert.equal(qs.get('after'), '2026-11-01');
  assert.equal(qs.get('before'), '2026-11-03');
  assert.equal(qs.get('has_file'), 'true');
  assert.equal(qs.get('limit'), '50', 'capped at 50');
  assert.equal(qs.get('cursor'), 'abc');
  const bare = new URLSearchParams(searchQuery({ query: 'x y', grupr_id: ROOM }));
  assert.deepEqual([...bare.keys()].sort(), ['limit', 'q', 'room']);
  assert.equal(bare.get('limit'), '10', 'default 10');
});

test('hits read as the agent or the person who posted, with the matches marked', async () => {
  const { hubEnvelope, calls } = fakeHub([
    {
      data: [
        {
          message_id: 'm1', grupr_id: ROOM, room_name: 'Ops', agent_id: AGENT, sender_name: 'Helper', created_at: '2026-11-23T10:00:00Z',
          snippet: [{ text: 'the ' }, { text: 'deploy', hit: true }, { text: ' is <b>done</b>' }], snippet_text: 'the deploy is <b>done</b>',
          content: 'the deploy is <b>done</b>', content_truncated: false, has_files: true,
        },
        {
          message_id: 'm2', grupr_id: ROOM, room_name: 'Ops', sender_id: USER, sender_name: 'Bob', created_at: '2026-11-22T10:00:00Z',
          snippet: [{ text: 'deploy', hit: true }, { text: ' tomorrow' }], snippet_text: 'deploy tomorrow', content: 'x'.repeat(2000), content_truncated: true,
        },
      ],
      meta: { count: 2, has_more: true, next_cursor: 'NEXT_1' },
    },
  ]);
  const res = await callSearchTool('grupr_search_messages', { query: 'deploy', room_id: ROOM }, hubEnvelope);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.startsWith('/search/messages?'), calls[0].path);
  assert.equal(calls[0].method, 'GET');
  const text = res.content[0].text;
  assert.ok(!res.isError);
  assert.ok(text.startsWith('2 messages matching "deploy", newest first:'), text);
  assert.ok(text.includes(`from agent Helper (agent_id ${AGENT}), with files`), text);
  assert.ok(text.includes(`from Bob (user_id ${USER})`), text);
  assert.ok(!text.includes(`user_id ${AGENT}`), 'an agent post never reads as a person');
  assert.ok(text.includes('Snippet: the «deploy» is <b>done</b>'), text);
  assert.ok(text.includes('Text (first 2,000 characters): '), text);
  assert.ok(text.includes('cursor "NEXT_1"'), text);
});

test('no hits, the last page, and a too-short query', async () => {
  const { hubEnvelope, calls } = fakeHub([
    { data: [], meta: { next_cursor: null } },
    { data: [{ message_id: 'm3', grupr_id: ROOM, sender_id: USER, sender_name: 'Bob', snippet_text: 'hello there' }], meta: { next_cursor: null } },
  ]);
  const none = await callSearchTool('grupr_search_messages', { query: 'nothing here' }, hubEnvelope);
  assert.match(none.content[0].text, /No messages match "nothing here"/);
  const last = await callSearchTool('grupr_search_messages', { query: 'hello', cursor: 'C' }, hubEnvelope);
  assert.match(last.content[0].text, /That is every match\./);
  assert.match(last.content[0].text, /Snippet: hello there/);
  const short = await callSearchTool('grupr_search_messages', { query: ' a ' }, hubEnvelope);
  assert.equal(short.isError, true);
  assert.equal(calls.length, 2, 'a too-short query never reaches the hub');
});

test('a refusal from the hub propagates to the server handler', async () => {
  const err = Object.assign(new Error('Agent is not assigned to this grupr'), { status: 403, code: 'forbidden' });
  const { hubEnvelope } = fakeHub([err]);
  await assert.rejects(() => callSearchTool('grupr_search_messages', { query: 'deploy', room_id: ROOM }, hubEnvelope), err);
});

test('helpers', () => {
  assert.equal(markedSnippet({ snippet_text: 'plain' }), 'plain');
  assert.equal(markedSnippet({ snippet: [{ text: 'a' }, { text: 'b', hit: true }] }), 'a«b»');
  assert.ok(describeHit({ message_id: 'm', grupr_id: ROOM, agent_id: AGENT }).includes(`from agent (agent_id ${AGENT})`));
});
