// Message cards (Slack parity C5a): grupr_send_message's card, and the
// grupr_card_actions tool. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_ACTIONS_TOOL, CARD_PROPERTY, cardActionsQuery, cardArg, describeCardActions } from '../dist/cards.js';
import { describePosted, sendMessageBody } from '../dist/threads.js';

const CARD = { v: 1, blocks: [{ type: 'header', text: 'Deploy 42' }] };

test('a card goes to the hub with its fallback content', () => {
  const r = sendMessageBody({ grupr_id: 'g', content: 'Deploy 42 is ready', card: CARD });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { content: 'Deploy 42 is ready', card: CARD });
  assert.equal(r.needsHub, true, 'the SDK path carries text only');
  // Some clients send object arguments as JSON text.
  const fromText = sendMessageBody({ content: 'x', card: JSON.stringify(CARD) });
  assert.deepEqual(fromText.body.card, CARD);
  // A card in a thread keeps both.
  const root = '3b9d2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';
  const threaded = sendMessageBody({ content: 'x', card: CARD, thread_root_id: root });
  assert.deepEqual(threaded.body, { content: 'x', card: CARD, thread_root_id: root });
});

test('a card needs a fallback and must be an object', () => {
  const none = sendMessageBody({ content: '  ', card: CARD });
  assert.equal(none.ok, false);
  assert.match(none.error, /fallback/);
  for (const bad of [[CARD], 'not json', 42, true]) {
    const r = cardArg({ content: 'x', card: bad });
    assert.equal(r.ok, false, `card ${JSON.stringify(bad)} was accepted`);
    assert.match(r.error, /JSON object/);
  }
  assert.deepEqual(cardArg({ content: 'x' }), { ok: true });
  assert.deepEqual(cardArg({ content: 'x', card: null }), { ok: true });
  // Without a card nothing changes: plain text keeps the SDK path.
  assert.equal(sendMessageBody({ content: 'hello' }).needsHub, false);
});

test('the answer says a card was posted', () => {
  const line = describePosted({ message_id: 'm1', created_at: 't' }, { content: 'x', card: CARD });
  assert.match(line, /^Posted a card\. message_id=m1/);
});

test('the schema explains every block and button, and https-only links', () => {
  const d = CARD_PROPERTY.card.description;
  for (const word of ['header', 'text', 'fields', 'table', 'image', 'link', 'actions', 'open_url', 'open_file', 'reply', 'agent_action', 'https://', 'fallback']) {
    assert.ok(d.includes(word), `card description lacks ${word}`);
  }
  assert.equal(CARD_PROPERTY.card.type, 'object');
});

test('grupr_card_actions: read-only, with its query', () => {
  assert.equal(CARD_ACTIONS_TOOL.name, 'grupr_card_actions');
  assert.equal(CARD_ACTIONS_TOOL.annotations.readOnlyHint, true);
  assert.ok(CARD_ACTIONS_TOOL.title);
  assert.equal(cardActionsQuery({}), '');
  assert.equal(cardActionsQuery({ room_id: ' r1 ', cursor: 'c', limit: 999 }), '?room_id=r1&cursor=c&limit=200');
  assert.equal(cardActionsQuery({ limit: 0 }), '?limit=1');
  const out = JSON.parse(describeCardActions([{ click_id: 'k', action_id: 'ship', clicker: { user_id: 'u', name: 'Bret' } }], 'next'));
  assert.equal(out.count, 1);
  assert.equal(out.next_cursor, 'next');
  assert.equal(out.clicks[0].action_id, 'ship');
  assert.match(out.note, /data/);
  assert.equal(JSON.parse(describeCardActions([], null)).count, 0);
});
