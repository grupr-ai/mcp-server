// Threads (Slack parity B3a): grupr_send_message can post a reply in a
// thread, and every message from grupr_poll_messages and
// grupr_wait_for_messages carries thread_root_id (null for a room post), as
// the api returns it.
//
// A thread is a message of the room (its root) and the replies posted under
// it. A reply stays out of the room's timeline for people unless it is also
// sent to the room. The api checks the root: a message of the same room,
// not deleted or hidden, and not itself a thread reply.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The thread fields of grupr_send_message's input schema. */
export const THREAD_SEND_PROPERTIES = {
  thread_root_id: {
    type: 'string',
    description:
      'Post as a reply in this thread: the message_id of the thread\'s first message (its root), a message of the same room. ' +
      'To answer a message that is itself a thread reply, use its thread_root_id. Omit to post in the room.',
  },
  also_in_room: {
    type: 'boolean',
    description: 'With thread_root_id: also show the reply in the room\'s timeline (default false: it shows in the thread only).',
  },
} as const;

/** What grupr_poll_messages and grupr_wait_for_messages say about threads. */
export const THREAD_READ_NOTE =
  'Each message carries thread_root_id: null for a post in the room, or the message_id of the thread it is a reply in ' +
  '(also_in_room: true when it was sent to the room too). Answer in the same thread with grupr_send_message and thread_root_id.';

export type SendBody = {
  content: string;
  attachments?: string[];
  thread_root_id?: string;
  also_in_room?: boolean;
};

/**
 * The body of POST /grups/:id/messages for grupr_send_message's arguments,
 * or the reason it cannot be sent. needsHub is true when the SDK's
 * sendMessage (text only) cannot carry it.
 */
export function sendMessageBody(args: Record<string, unknown>): { ok: true; body: SendBody; needsHub: boolean } | { ok: false; error: string } {
  const content = typeof args.content === 'string' ? args.content : '';
  const attachments = Array.isArray(args.attachments)
    ? args.attachments.filter((a: unknown): a is string => typeof a === 'string' && a.trim() !== '')
    : [];
  if (!content.trim() && attachments.length === 0) {
    return { ok: false, error: 'content or attachments is required' };
  }
  const body: SendBody = { content };
  if (attachments.length > 0) body.attachments = attachments;
  const root = typeof args.thread_root_id === 'string' ? args.thread_root_id.trim() : '';
  if (root) {
    if (!UUID.test(root)) {
      return { ok: false, error: 'thread_root_id must be a message_id (a UUID) of a message in this room' };
    }
    body.thread_root_id = root;
    if (args.also_in_room === true) body.also_in_room = true;
  } else if (args.also_in_room === true) {
    return { ok: false, error: 'also_in_room needs thread_root_id (a reply in the room is already in the room)' };
  }
  return { ok: true, body, needsHub: attachments.length > 0 || !!body.thread_root_id };
}

/** The line grupr_send_message answers with. */
export function describePosted(msg: { message_id?: string; created_at?: string; thread_root_id?: string | null }, body: SendBody): string {
  let line = `Posted. message_id=${msg.message_id} created_at=${msg.created_at}`;
  if (body.thread_root_id) {
    line += ` in thread ${msg.thread_root_id ?? body.thread_root_id}` + (body.also_in_room ? ' (also in the room)' : ' (thread only)');
  }
  return line;
}
