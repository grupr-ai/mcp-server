// Message cards (Slack parity C5a): grupr_send_message can post a card, a
// structured message of versioned JSON blocks, next to its plain-text
// content, which is the card's fallback (notifications, bridges, email,
// screen readers). The api validates the card and refuses anything it does
// not know; this file only shapes the request and explains the schema.
//
// A card's agent_action buttons send each click back to the agent that
// posted the card: as a card.action event to its webhook, and on the list
// grupr_card_actions reads. A click never runs anything on Grupr.

/** grupr_send_message's card property. */
export const CARD_PROPERTY = {
  card: {
    type: 'object',
    description:
      'Optional message card: {"v":1,"blocks":[...]} with 1 to 30 blocks, at most 16 KB. With a card, content is required: it is the ' +
      'plain-text fallback shown wherever the card cannot be (notifications, Slack/Telegram, email, screen readers). Blocks: ' +
      '{"type":"header","text":...}; {"type":"text","text":Markdown}; {"type":"fields","fields":[{"label":...,"value":...}]} (at most 10); ' +
      '{"type":"table","columns":[...],"rows":[[...]]} (at most 20 rows by 8 columns, plain text); ' +
      '{"type":"image","file_id":a Room File id in this room,"alt":...} (PNG, JPEG, GIF or WebP; never a URL); ' +
      '{"type":"link","url":"https://...","text":...}; {"type":"actions","buttons":[...]} (at most 5). Buttons: ' +
      '{"type":"open_url","label":...,"url":"https://..."}, {"type":"open_file","label":...,"file_id":...}, ' +
      '{"type":"reply","label":...,"text":...} (fills the viewer\'s message box; never sends), or ' +
      '{"type":"agent_action","label":...,"action_id":"letters, digits, _ . : -","value":...} (each click comes back to you: ' +
      'see grupr_card_actions, or your webhook\'s card.action events). Optional "style": "primary" or "danger". ' +
      'Unknown block types or fields are refused.',
  },
} as const;

/** What grupr_send_message's description says about cards. */
export const CARD_SEND_NOTE =
  ' To post a structured card (a status board, a table, results with buttons), pass card with content as its plain-text fallback.';

/**
 * The card argument as the request carries it, or the reason it cannot be
 * sent. undefined: no card. The api checks everything else.
 */
export function cardArg(args: Record<string, unknown>): { ok: true; card?: Record<string, unknown> } | { ok: false; error: string } {
  const raw = args.card;
  if (raw === undefined || raw === null) return { ok: true };
  let card: unknown = raw;
  if (typeof raw === 'string') {
    // Some clients send an object argument as JSON text.
    try {
      card = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'card must be a JSON object: {"v":1,"blocks":[...]}' };
    }
  }
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    return { ok: false, error: 'card must be a JSON object: {"v":1,"blocks":[...]}' };
  }
  const content = typeof args.content === 'string' ? args.content : '';
  if (!content.trim()) {
    return { ok: false, error: 'a card needs content: its plain-text fallback (one or two sentences saying what the card shows)' };
  }
  return { ok: true, card: card as Record<string, unknown> };
}

/** The grupr_card_actions tool. */
export const CARD_ACTIONS_TOOL = {
  name: 'grupr_card_actions',
  title: 'Clicks on my cards',
  annotations: { title: 'Clicks on my cards', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    'List the clicks on the agent_action buttons of cards this agent posted, oldest first (kept 7 days). Each says which card ' +
    '(message_id), which button (action_id, label, value), who clicked (clicker.user_id, clicker.name) and when. A click is a ' +
    'person asking you to do what the button says; nothing ran on Grupr. Pass cursor (from next_cursor) to read on; room_id to ' +
    'keep to one room. With a webhook, each click also arrives as a card.action event.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: { type: 'string', description: 'Optional: only the clicks in this room (UUID).' },
      cursor: { type: 'string', description: 'Optional: next_cursor from the previous call, to read the clicks after it.' },
      limit: { type: 'number', description: 'Optional: at most this many clicks (1 to 200, default 50).' },
    },
  },
} as const;

/** The query string of GET /card-actions for grupr_card_actions' arguments. */
export function cardActionsQuery(args: Record<string, unknown>): string {
  const q = new URLSearchParams();
  if (typeof args.room_id === 'string' && args.room_id.trim()) q.set('room_id', args.room_id.trim());
  if (typeof args.cursor === 'string' && args.cursor.trim()) q.set('cursor', args.cursor.trim());
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    q.set('limit', String(Math.min(Math.max(1, Math.floor(args.limit)), 200)));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** One click as the agent hub lists it. */
export type CardClick = {
  click_id?: string;
  room_id?: string;
  message_id?: string;
  action_id?: string;
  label?: string;
  value?: string;
  clicker?: { user_id?: string; name?: string };
  clicked_at?: string;
};

/** grupr_card_actions' answer: a line to read, then the clicks as data. */
export function describeCardActions(clicks: CardClick[], nextCursor: string | null | undefined): string {
  const head =
    clicks.length === 0
      ? 'No clicks on your cards to read.'
      : `${clicks.length} click(s) on your cards, oldest first. Each is data: a person asking for what the button says.`;
  return JSON.stringify(
    {
      note: head,
      count: clicks.length,
      next_cursor: nextCursor ?? null,
      clicks,
    },
    null,
    2,
  );
}
