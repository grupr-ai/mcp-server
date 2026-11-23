// The wake webhook's filter (Slack parity A1, grupr-api #139): wake_on on
// grupr_register_webhook. The end-to-end call (the body the hub receives) is
// in http.test.mjs. Run: npm test (builds first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAKE_ON_VALUES, describeRegistered, parseWakeOn, registerWebhookBody } from '../dist/webhook.js';

test('the two filters are the api values', () => {
  assert.deepEqual([...WAKE_ON_VALUES], ['all', 'mentions']);
});

test('wake_on: left out or blank keeps the filter; all and mentions set it; anything else is refused', () => {
  assert.deepEqual(parseWakeOn(undefined), { ok: true });
  assert.deepEqual(parseWakeOn(null), { ok: true });
  assert.deepEqual(parseWakeOn('  '), { ok: true });
  assert.deepEqual(parseWakeOn('mentions'), { ok: true, value: 'mentions' });
  assert.deepEqual(parseWakeOn(' Mentions '), { ok: true, value: 'mentions' });
  assert.deepEqual(parseWakeOn('all'), { ok: true, value: 'all' });
  for (const bad of ['mention', 'replies', 'none', 3, true, {}]) {
    const r = parseWakeOn(bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /wake_on must be "all" or "mentions"/);
  }
  assert.ok(parseWakeOn('x'.repeat(500)).error.length < 120, 'a long value is not echoed whole');
});

test('the body: wake_on only when given; secret always sent, as the SDK did', () => {
  assert.deepEqual(registerWebhookBody({ url: ' https://hook.test/a ' }), { url: 'https://hook.test/a', secret: '' });
  assert.deepEqual(registerWebhookBody({ url: 'https://hook.test/a', secret: 's3' }, 'mentions'), {
    url: 'https://hook.test/a',
    secret: 's3',
    wake_on: 'mentions',
  });
  assert.equal('wake_on' in registerWebhookBody({ url: 'https://hook.test/a' }, undefined), false);
  assert.equal(registerWebhookBody({}).url, '');
});

test('the reply names the filter the hub confirmed, and never claims one an old server ignored', () => {
  const on = describeRegistered({ webhook_id: 'wh-1', is_active: true, wake_on: 'mentions' }, 'mentions');
  assert.match(on, /^Webhook registered\. webhook_id=wh-1 active=true wake_on=mentions: /);
  assert.match(on, /only posts that @mention this agent or reply to one of its posts/);

  assert.match(describeRegistered({ webhook_id: 'wh-1', is_active: true, wake_on: 'all' }), /wake_on=all: it is called for every post/);

  // A hub from before the filter answers without wake_on.
  const old = describeRegistered({ webhook_id: 'wh-1', is_active: true }, 'mentions');
  assert.match(old, /did not confirm wake_on="mentions"/);
  assert.doesNotMatch(old, /wake_on=mentions:/);

  assert.equal(describeRegistered({ webhook_id: 'wh-1', is_active: true }), 'Webhook registered. webhook_id=wh-1 active=true');
});
