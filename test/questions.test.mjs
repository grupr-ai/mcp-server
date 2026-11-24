// Ask the owner (Slack parity A2): grupr_ask_owner and grupr_question
// against a fake agent hub. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WAIT_SECONDS,
  QUESTION_TOOLS,
  QUESTION_TOOL_META,
  callQuestionTool,
  describeQuestion,
  isQuestionTool,
} from '../dist/questions.js';

const ID = '7a1c2e3f-4b5d-4c6e-8f90-a1b2c3d4e5f6';

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

test('both tools are listed with a title and annotations', () => {
  const names = QUESTION_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['grupr_ask_owner', 'grupr_question']);
  for (const n of names) {
    assert.ok(isQuestionTool(n));
    assert.ok(QUESTION_TOOL_META[n].title && QUESTION_TOOL_META[n].annotations.title === QUESTION_TOOL_META[n].title);
  }
  assert.equal(QUESTION_TOOL_META.grupr_question.annotations.readOnlyHint, true);
  assert.equal(QUESTION_TOOL_META.grupr_ask_owner.annotations.readOnlyHint, false);
  assert.equal(QUESTION_TOOL_META.grupr_ask_owner.annotations.destructiveHint, false);
  const ask = QUESTION_TOOLS[0];
  assert.deepEqual(ask.inputSchema.required, ['text']);
  assert.equal(ask.inputSchema.properties.choices.maxItems, 5);
  assert.ok(!isQuestionTool('grupr_rooms'));
});

test('grupr_ask_owner posts the question, its choices and room, and returns the id', async () => {
  const { hubJSON, calls } = fakeHub([
    { question: { id: ID, status: 'open', text: 'Ship Friday?', choices: ['Yes', 'No'], room_id: 'r1', expires_at: '2026-11-30T12:00:00Z', answer: null } },
  ]);
  const res = await callQuestionTool('grupr_ask_owner', { text: 'Ship Friday?', choices: ['Yes', 'No'], room_id: 'r1' }, hubJSON);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/questions');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { text: 'Ship Friday?', choices: ['Yes', 'No'], room_id: 'r1' });
  const text = res.content[0].text;
  assert.ok(text.includes(`question_id ${ID}: open`), text);
  assert.ok(text.includes('grupr_question'), text);
});

test('grupr_ask_owner accepts grupr_id as the room and sends no empty fields', async () => {
  const { hubJSON, calls } = fakeHub([{ question: { id: ID, status: 'open', text: 'Why?', choices: [] } }]);
  await callQuestionTool('grupr_ask_owner', { text: 'Why?', grupr_id: 'r9' }, hubJSON);
  assert.deepEqual(calls[0].body, { text: 'Why?', room_id: 'r9' });
  const { hubJSON: h2, calls: c2 } = fakeHub([{ question: { id: ID, status: 'open', text: 'Why?' } }]);
  await callQuestionTool('grupr_ask_owner', { text: 'Why?' }, h2);
  assert.deepEqual(c2[0].body, { text: 'Why?' });
});

test('a refusal from the hub (a limit) propagates to the server handler', async () => {
  const err = new Error('This agent already has 5 open questions for its owner.');
  const { hubJSON } = fakeHub([err]);
  await assert.rejects(() => callQuestionTool('grupr_ask_owner', { text: 'More?' }, hubJSON), err);
});

test('grupr_question reads once by default', async () => {
  const { hubJSON, calls } = fakeHub([{ question: { id: ID, status: 'open', text: 'Ship?', choices: ['Yes'] } }]);
  const res = await callQuestionTool('grupr_question', { question_id: ID }, hubJSON);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/questions/${ID}`);
  assert.ok(res.content[0].text.includes(': open'));
});

test('grupr_question waits for the answer and returns it', async () => {
  const { hubJSON, calls } = fakeHub([
    { question: { id: ID, status: 'open', text: 'Ship?' } },
    { question: { id: ID, status: 'open', text: 'Ship?' } },
    { question: { id: ID, status: 'answered', text: 'Ship?', answer: { choice: 'Yes', text: 'after CI', answered_at: '2026-11-23T12:00:00Z' } } },
  ]);
  const res = await callQuestionTool('grupr_question', { question_id: ID, wait_seconds: 5 }, hubJSON, { pollMs: 10 });
  assert.equal(calls.length, 3);
  const text = res.content[0].text;
  assert.ok(text.includes(': answered') && text.includes('Choice: Yes') && text.includes('Answer: after CI'), text);
});

test('grupr_question stops waiting at the deadline', async () => {
  const open = { question: { id: ID, status: 'open', text: 'Ship?' } };
  const { hubJSON, calls } = fakeHub(Array.from({ length: 50 }, () => open));
  const started = Date.now();
  await callQuestionTool('grupr_question', { question_id: ID, wait_seconds: 0.2 }, hubJSON, { pollMs: 50 });
  assert.ok(Date.now() - started < 1000);
  assert.ok(calls.length >= 2 && calls.length <= 6, `${calls.length} reads`);
});

test('an expired question says so', () => {
  const text = describeQuestion({ id: ID, status: 'expired', text: 'Ship?', choices: ['Yes', 'No'] });
  assert.ok(text.includes(': expired') && text.includes('7 days') && text.includes('Choices offered: Yes | No'), text);
});

test("the wait stays under a TypeScript MCP client's 60 s request timeout", () => {
  assert.equal(MAX_WAIT_SECONDS, 50);
  const q = QUESTION_TOOLS.find((t) => t.name === 'grupr_question');
  assert.ok(q.description.includes('up to 50') && !q.description.includes('120'), q.description);
  assert.ok(q.inputSchema.properties.wait_seconds.description.includes('max 50'));
});
