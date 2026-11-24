// Threads (Slack parity B3a): grupr_send_message's thread option, and what
// the read tools say about thread_root_id. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREAD_READ_NOTE, THREAD_SEND_PROPERTIES, describePosted, sendMessageBody } from '../dist/threads.js';

const ROOT = '3b9d2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';

test('a plain text post keeps the SDK path and no thread fields', () => {
  const r = sendMessageBody({ grupr_id: 'g', content: 'hello' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { content: 'hello' });
  assert.equal(r.needsHub, false);
});

test('a thread reply goes to the hub with thread_root_id, and also_in_room only when asked', () => {
  const r = sendMessageBody({ content: 'in thread', thread_root_id: ROOT });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { content: 'in thread', thread_root_id: ROOT });
  assert.equal(r.needsHub, true);
  const also = sendMessageBody({ content: 'x', thread_root_id: ` ${ROOT} `, also_in_room: true });
  assert.deepEqual(also.body, { content: 'x', thread_root_id: ROOT, also_in_room: true });
  const files = sendMessageBody({ content: '', attachments: ['a.md', ''], thread_root_id: ROOT });
  assert.deepEqual(files.body, { content: '', attachments: ['a.md'], thread_root_id: ROOT });
});

test('refusals: nothing to send, a malformed root, also_in_room without a thread', () => {
  assert.equal(sendMessageBody({ content: '  ' }).ok, false);
  const bad = sendMessageBody({ content: 'x', thread_root_id: 'not-a-uuid' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /thread_root_id/);
  const lone = sendMessageBody({ content: 'x', also_in_room: true });
  assert.equal(lone.ok, false);
  assert.match(lone.error, /also_in_room needs thread_root_id/);
});

test('the answer names the thread', () => {
  const line = describePosted({ message_id: 'm1', created_at: 't', thread_root_id: ROOT }, { content: 'x', thread_root_id: ROOT });
  assert.match(line, /message_id=m1/);
  assert.match(line, new RegExp(`in thread ${ROOT} \\(thread only\\)`));
  assert.equal(describePosted({ message_id: 'm2', created_at: 't' }, { content: 'x' }), 'Posted. message_id=m2 created_at=t');
});

test('the schema and the read note describe the fields', () => {
  assert.equal(THREAD_SEND_PROPERTIES.thread_root_id.type, 'string');
  assert.equal(THREAD_SEND_PROPERTIES.also_in_room.type, 'boolean');
  assert.match(THREAD_READ_NOTE, /thread_root_id/);
});
