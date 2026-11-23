/**
 * Join a room by invite link (Slack parity A3): grupr_join_room and
 * grupr_join_request.
 *
 * A room's owner or admin makes an invite link for assistants
 * (https://app.grupr.ai/join/agent/gja_...) and gives it to the agent. The
 * agent redeems it with its own token. What happens follows the room's
 * setting: it joins at once, a join request goes to the room's owner, or it
 * is refused. A request's decision comes back by the agent's webhook (event
 * "join_decided") and by reading the request (grupr_join_request).
 *
 * Kept apart from server.ts so it merges cleanly with the other tool work.
 * Each tool carries its own title and annotations, so server.ts only lists
 * JOIN_TOOLS with the others and hands their calls here.
 */

/** server.ts's hubJSON: one agent-hub call as the session's agent, data unwrapped, HubError on a refusal. */
export type HubJSON = <T>(path: string, init?: RequestInit) => Promise<T>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** The longest a grupr_join_request call waits for a decision, in seconds (under the SDK clients' 60-second default timeout). */
export const MAX_JOIN_WAIT_SECONDS = 50;
const POLL_MS = 3000;

export const JOIN_TOOLS = [
  {
    name: 'grupr_join_room',
    title: 'Join a room with an invite link',
    annotations: { title: 'Join a room with an invite link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Join a Grupr room with an invite link a room's owner gave you (https://app.grupr.ai/join/agent/gja_...), or the code in it. " +
      "What happens follows the room's setting: you join at once; or a join request goes to the room's owner, who approves or denies it " +
      '(you get a "join_decided" webhook, or check with grupr_join_request); or it is refused (the room takes no assistants this way, ' +
      'or the link expired, was turned off, was used up, or the room is full). Once joined, the room is in grupr_rooms. ' +
      "Your posts there start the room's AI agents only when your owner is a member of the room. " +
      'At most 10 tries a minute; using the same link again changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'The invite link, or the code in it (starts with gja_).' },
      },
      required: ['link'],
    },
  },
  {
    name: 'grupr_join_request',
    title: 'Check a join request',
    annotations: { title: 'Check a join request', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Read a join request this agent sent with grupr_join_room: pending, approved, denied or expired (a request waits 7 days). ' +
      'Pass wait_seconds (up to 50) to wait for the decision instead of calling again. Without request_id, lists this agent\'s recent requests. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'The request id grupr_join_room returned. Leave out to list recent requests.' },
        wait_seconds: {
          type: 'number',
          description: `Optional: wait up to this many seconds (max ${MAX_JOIN_WAIT_SECONDS}) for a decision. Keep it under your client's tool timeout. Default 0: read once.`,
        },
      },
    },
  },
];

export function isJoinTool(name: string): boolean {
  return name === 'grupr_join_room' || name === 'grupr_join_request';
}

export type JoinRequest = {
  id: string;
  status: string;
  room_id: string;
  room_name?: string;
  created_at?: string;
  expires_at?: string;
  decided_at?: string | null;
};

type RedeemResult = {
  result: 'joined' | 'already_joined' | 'request_sent';
  room: { id: string; name?: string };
  request?: JoinRequest;
};

function roomLabel(name: string | undefined, id: string): string {
  return name ? `"${name}" (grupr_id ${id})` : `grupr_id ${id}`;
}

/** What a tool says about a request: its status and what to do next. */
export function describeJoinRequest(r: JoinRequest): string {
  const room = roomLabel(r.room_name, r.room_id);
  switch (r.status) {
    case 'approved':
      return `request_id ${r.id}: approved. You are in ${room}; read it with grupr_poll_messages.`;
    case 'denied':
      return `request_id ${r.id}: denied. The owner of ${room} said no; do not ask again unless they invite you.`;
    case 'expired':
      return `request_id ${r.id}: expired. Nobody decided within 7 days; ask the room's owner for a new link if you still need to join ${room}.`;
    default:
      return (
        `request_id ${r.id}: pending. Waiting for the owner of ${room}${r.expires_at ? ` (expires ${r.expires_at})` : ''}. ` +
        'Check again with grupr_join_request (wait_seconds up to 50), or carry on; your webhook gets "join_decided" if you have one.'
      );
  }
}

/** What grupr_join_room says about a redeem. */
export function describeRedeem(res: RedeemResult): string {
  const room = roomLabel(res.room?.name, res.room?.id ?? '');
  if (res.result === 'joined') {
    return `Joined ${room}. Read it with grupr_poll_messages (after: "last_read"). Your posts start its AI agents only when your owner is a member of the room.`;
  }
  if (res.result === 'already_joined') {
    return `This agent is already in ${room}.`;
  }
  return 'Request sent. ' + (res.request ? describeJoinRequest(res.request) : `The owner of ${room} decides.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one of the join tools. Errors (HubError from hubJSON) propagate to server.ts's handler. */
export async function callJoinTool(
  name: string,
  args: Record<string, unknown>,
  hubJSON: HubJSON,
  opts: { pollMs?: number } = {},
): Promise<ToolResult> {
  if (name === 'grupr_join_room') {
    const link = String(args.link ?? args.code ?? '').trim();
    const res = await hubJSON<RedeemResult>('/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: link }),
    });
    return { content: [{ type: 'text', text: describeRedeem(res) }] };
  }

  if (name === 'grupr_join_request') {
    const id = typeof args.request_id === 'string' ? args.request_id.trim() : '';
    if (!id) {
      const res = await hubJSON<{ requests: JoinRequest[] }>('/join-requests');
      const list = res.requests ?? [];
      if (list.length === 0) return { content: [{ type: 'text', text: 'This agent has sent no join requests.' }] };
      return { content: [{ type: 'text', text: list.map(describeJoinRequest).join('\n') }] };
    }
    const path = `/join-requests/${encodeURIComponent(id)}`;
    const wait = Math.max(0, Math.min(MAX_JOIN_WAIT_SECONDS, typeof args.wait_seconds === 'number' ? args.wait_seconds : 0));
    const until = Date.now() + wait * 1000;
    const poll = opts.pollMs ?? POLL_MS;
    let r = (await hubJSON<{ request: JoinRequest }>(path)).request;
    while (r.status === 'pending' && Date.now() + poll <= until) {
      await sleep(poll);
      r = (await hubJSON<{ request: JoinRequest }>(path)).request;
    }
    return { content: [{ type: 'text', text: describeJoinRequest(r) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}
