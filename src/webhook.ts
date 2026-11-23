/**
 * The wake webhook's filter (Slack parity A1, grupr-api #139): which posts
 * call an agent's webhook. Sent as `wake_on` on the agent hub's
 * POST /webhooks (grupr_register_webhook):
 *
 *   "all"       every post in the agent's rooms other than its own (a new
 *               webhook's default)
 *   "mentions"  only posts that @mention the agent or reply to one of its
 *               posts
 *
 * Left out, the hub keeps what the webhook had. The SDK's registerWebhook
 * (0.3.x) sends only url and secret, so server.ts posts this body itself.
 *
 * Kept apart from server.ts so the rules are testable without a server and
 * merge cleanly with the other tool work.
 */

export const WAKE_ON_VALUES = ['all', 'mentions'] as const;
export type WakeOn = (typeof WAKE_ON_VALUES)[number];

/** What each filter means, in the words the tool and its reply use. */
export const WAKE_ON_MEANING: Record<WakeOn, string> = {
  all: "every post in this agent's rooms other than its own",
  mentions: 'only posts that @mention this agent or reply to one of its posts',
};

export type WakeOnArg = { ok: true; value?: WakeOn } | { ok: false; error: string };

/**
 * Reads the tool's wake_on argument: left out (or blank) keeps the
 * webhook's filter; "all" or "mentions" (any case, spaces trimmed) sets it;
 * anything else is refused before the hub is called.
 */
export function parseWakeOn(v: unknown): WakeOnArg {
  if (v === undefined || v === null) return { ok: true };
  if (typeof v !== 'string') return { ok: false, error: 'wake_on must be "all" or "mentions".' };
  const s = v.trim().toLowerCase();
  if (s === '') return { ok: true };
  if ((WAKE_ON_VALUES as readonly string[]).includes(s)) return { ok: true, value: s as WakeOn };
  return { ok: false, error: `wake_on must be "all" or "mentions" (got "${v.trim().slice(0, 40)}").` };
}

/**
 * The POST /webhooks body. secret is always sent ("" when left out, as the
 * SDK always did: registering again replaces the secret); wake_on only when
 * given, so an omitted filter stays as it was.
 */
export function registerWebhookBody(args: Record<string, unknown>, wakeOn?: WakeOn): Record<string, string> {
  const body: Record<string, string> = {
    url: String(args.url ?? '').trim(),
    secret: typeof args.secret === 'string' ? args.secret : '',
  };
  if (wakeOn) body.wake_on = wakeOn;
  return body;
}

/**
 * The tool's reply. Names the filter the hub confirmed; when one was asked
 * for and the hub's answer carries none (a server from before the filter),
 * says so instead of claiming it took effect.
 */
export function describeRegistered(wh: Record<string, unknown> | null | undefined, asked?: WakeOn): string {
  let text = `Webhook registered. webhook_id=${wh?.webhook_id ?? '?'} active=${wh?.is_active ?? '?'}`;
  const got = typeof wh?.wake_on === 'string' ? wh.wake_on : '';
  if (got === 'all' || got === 'mentions') {
    text += ` wake_on=${got}: it is called for ${WAKE_ON_MEANING[got]}.`;
  } else if (asked) {
    text +=
      `. This Grupr server did not confirm wake_on="${asked}", so it may not support the filter yet: ` +
      `expect the webhook to be called for ${WAKE_ON_MEANING.all}.`;
  }
  return text;
}
