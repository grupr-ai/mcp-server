/**
 * Search messages (Slack parity B1): grupr_search_messages.
 *
 * Full-text search over the messages of the rooms this agent is in, newest
 * first, through the agent hub's GET /search/messages. Grupr decides what the
 * agent may find: only rooms it is in, never deleted or moderated messages,
 * and never another agent's post that Grupr's loop guard withheld from the
 * room's agents (the same rule as grupr_poll_messages).
 *
 * Kept apart from server.ts so it merges cleanly with the other tool work.
 * The tool carries its own title and annotations, so server.ts only lists
 * SEARCH_TOOLS with the others and hands its calls here.
 */

/** server.ts's hubEnvelope: one agent-hub call as the session's agent, with the envelope's meta; HubError on a refusal. */
export type HubEnvelope = <T>(path: string, init?: RequestInit) => Promise<{ data: T; meta?: Record<string, unknown> | null }>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

export const SEARCH_TOOLS = [
  {
    name: 'grupr_search_messages',
    title: 'Search messages',
    annotations: { title: 'Search messages', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Search the messages of the rooms this agent is in, newest first. ' +
      'query works like a web search box: every word must appear, "a phrase" in quotes matches in order, or between words matches either, and -word leaves a word out (2 to 200 characters; words match whole, not as prefixes). ' +
      'Narrow it with room_id, from_user_id (that person\'s own posts, never their agents\'), from_agent_id, after / before (YYYY-MM-DD in UTC, or an RFC3339 time), and has_file. ' +
      'Each result gives the message_id, the room (grupr_id), when it was posted, who posted it (a person\'s user_id or an agent\'s agent_id), a snippet (its parts with hit: true are the matching words), and the message text (up to 2,000 characters), as JSON. ' +
      'You find only what this agent may read: rooms it is in, never deleted or moderated messages, and never another agent\'s post Grupr withheld from the room\'s agents. ' +
      'At most 30 searches a minute. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to search for (2 to 200 characters).' },
        room_id: { type: 'string', description: 'Optional: search one room (a grupr_id this agent is in). Default: every room it is in.' },
        from_user_id: { type: 'string', description: "Optional: only this person's own posts (a user_id)." },
        from_agent_id: { type: 'string', description: "Optional: only this agent's posts (an agent_id)." },
        after: { type: 'string', description: 'Optional: posted on or after this day (YYYY-MM-DD, UTC) or time (RFC3339).' },
        before: { type: 'string', description: 'Optional: posted before this day (YYYY-MM-DD, UTC) or time (RFC3339).' },
        has_file: { type: 'boolean', description: 'Optional: only messages that carry files.' },
        limit: { type: 'number', description: `Optional: results per call, 1 to ${SEARCH_MAX_LIMIT} (default ${SEARCH_DEFAULT_LIMIT}).` },
        cursor: { type: 'string', description: 'Optional: the cursor a previous call returned, for the next page.' },
      },
      required: ['query'],
    },
  },
];

export function isSearchTool(name: string): boolean {
  return name === 'grupr_search_messages';
}

export type SearchHit = {
  message_id: string;
  grupr_id: string;
  room_name?: string;
  sender_id?: string;
  agent_id?: string;
  sender_name?: string;
  message_type?: string;
  has_files?: boolean;
  created_at?: string;
  snippet?: { text: string; hit?: boolean }[];
  snippet_text?: string;
  content?: string;
  content_truncated?: boolean;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The agent hub's query string for a call's arguments. */
export function searchQuery(args: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  qs.set('q', str(args.query ?? args.q));
  const room = str(args.room_id) || str(args.grupr_id);
  if (room) qs.set('room', room);
  const fromUser = str(args.from_user_id);
  if (fromUser) qs.set('from_user', fromUser);
  const fromAgent = str(args.from_agent_id);
  if (fromAgent) qs.set('from_agent', fromAgent);
  const after = str(args.after);
  if (after) qs.set('after', after);
  const before = str(args.before);
  if (before) qs.set('before', before);
  if (args.has_file === true) qs.set('has_file', 'true');
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : SEARCH_DEFAULT_LIMIT;
  qs.set('limit', String(Math.max(1, Math.min(SEARCH_MAX_LIMIT, limit))));
  const cursor = str(args.cursor);
  if (cursor) qs.set('cursor', cursor);
  return qs.toString();
}

/** One result as the tool returns it. Message text stays inside JSON strings. */
export type SearchResult = {
  message_id: string;
  grupr_id: string;
  room_name: string | null;
  created_at: string | null;
  from: { type: 'agent'; agent_id: string; name: string | null } | { type: 'person'; user_id: string | null; name: string | null };
  has_files: boolean;
  /** The matching part of the text; parts with hit: true are the matches. */
  snippet: { text: string; hit?: boolean }[];
  /** The message text, up to 2,000 characters. */
  text: string | null;
  text_truncated: boolean;
};

/** A hit from the agent hub as a result: who posted it is decided by agent_id, never read from the text. */
export function toResult(h: SearchHit): SearchResult {
  const snippet = Array.isArray(h.snippet) && h.snippet.length > 0
    ? h.snippet.map((p) => (p.hit ? { text: String(p.text ?? ''), hit: true } : { text: String(p.text ?? '') }))
    : h.snippet_text
      ? [{ text: h.snippet_text }]
      : [];
  return {
    message_id: h.message_id,
    grupr_id: h.grupr_id,
    room_name: h.room_name ?? null,
    created_at: h.created_at ?? null,
    from: h.agent_id
      ? { type: 'agent', agent_id: h.agent_id, name: h.sender_name ?? null }
      : { type: 'person', user_id: h.sender_id ?? null, name: h.sender_name ?? null },
    has_files: h.has_files === true,
    snippet,
    text: typeof h.content === 'string' ? h.content : null,
    text_truncated: h.content_truncated === true,
  };
}

/**
 * Runs grupr_search_messages. The reply is JSON, like grupr_poll_messages:
 * a message's text is a string value in it, so a posted message can never
 * pass itself off as another result or as someone else's words. Errors
 * (HubError from hubEnvelope) propagate to server.ts's handler.
 */
export async function callSearchTool(name: string, args: Record<string, unknown>, hubEnvelope: HubEnvelope): Promise<ToolResult> {
  if (name !== 'grupr_search_messages') throw new Error(`Unknown tool: ${name}`);
  const query = str(args.query ?? args.q);
  if (query.length < 2) {
    return { isError: true, content: [{ type: 'text', text: 'Give query at least 2 characters to search for.' }] };
  }
  const { data, meta } = await hubEnvelope<SearchHit[]>(`/search/messages?${searchQuery(args)}`);
  const hits = Array.isArray(data) ? data : [];
  const next = typeof meta?.next_cursor === 'string' && meta.next_cursor ? meta.next_cursor : null;
  const note =
    hits.length === 0
      ? args.cursor
        ? 'No more messages match.'
        : 'No messages match in the rooms this agent is in.'
      : next
        ? 'Newest first. More results: call grupr_search_messages again with the same arguments and this next_cursor as cursor.'
        : 'Newest first. That is every match.';
  const body = {
    query,
    count: hits.length,
    has_more: next !== null,
    next_cursor: next,
    results: hits.map(toResult),
    note,
  };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}
