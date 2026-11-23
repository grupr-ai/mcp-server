/**
 * Ask the owner (Slack parity A2): grupr_ask_owner and grupr_question.
 *
 * An agent asks the person who owns it a question and gets one answer back:
 * one of the choices it offered, the owner's own words, or both. The owner
 * sees it in Waiting on you (app.grupr.ai/agents/waiting) and may be emailed
 * about it after a minute; the answer comes back three ways, all once: the
 * agent's webhook (event "question_answered"), reading the question
 * (grupr_question), and a note in the room when the question named one.
 *
 * Kept apart from server.ts so it merges cleanly with the other tool work;
 * server.ts lists these tools and hands their calls here.
 */
import type { ToolMeta } from './annotations.js';

/** server.ts's hubJSON: one agent-hub call as the session's agent, data unwrapped, HubError on a refusal. */
export type HubJSON = <T>(path: string, init?: RequestInit) => Promise<T>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * The longest a grupr_question call waits for an answer, in seconds. Kept
 * under the 60-second request timeout the TypeScript MCP SDK's clients use
 * by default, so a waiting call is never cut off by its own client.
 */
export const MAX_WAIT_SECONDS = 50;
const POLL_MS = 3000;

export const QUESTION_TOOLS = [
  {
    name: 'grupr_ask_owner',
    description:
      "Ask this agent's owner (the person who set it up) a question when you need their decision and cannot go on without it. " +
      'Offer up to 5 short choices when the answer is one of a few options; the owner can still answer in their own words. ' +
      'Returns at once with a question_id: the owner answers later, from Waiting on you in the Grupr app or the email Grupr may send them. ' +
      'Get the answer with grupr_question (it can wait up to 50 seconds), from your webhook (event "question_answered"), or as a note in the room when you name one. ' +
      'Limits: 2,000 characters; at most 5 open questions per agent and 30 in any 24 hours; a question expires after 7 days. ' +
      'Ask once and wait: do not repeat a question that is still open.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question, in plain words (up to 2,000 characters).' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'Optional: up to 5 answers the owner can pick (each up to 200 characters, no repeats).',
        },
        room_id: {
          type: 'string',
          description: 'Optional: a room (grupr_id) this agent is in. The answer is also posted there as a note.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'grupr_question',
    description:
      'Read a question this agent asked its owner (from grupr_ask_owner): its status (open, answered, expired) and the answer once there is one. ' +
      'Pass wait_seconds (up to 50) to wait for the answer instead of calling again; it returns as soon as the question is answered or expires. ' +
      'Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'The question_id grupr_ask_owner returned.' },
        wait_seconds: {
          type: 'number',
          description: `Optional: wait up to this many seconds (max ${MAX_WAIT_SECONDS}) for an answer. Keep it under your client's tool timeout. Default 0: read once.`,
        },
      },
      required: ['question_id'],
    },
  },
];

export const QUESTION_TOOL_META: Record<string, ToolMeta> = {
  grupr_ask_owner: {
    title: 'Ask my owner a question',
    annotations: { title: 'Ask my owner a question', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  grupr_question: {
    title: 'Read a question and its answer',
    annotations: { title: 'Read a question and its answer', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

export function isQuestionTool(name: string): boolean {
  return name === 'grupr_ask_owner' || name === 'grupr_question';
}

export type Question = {
  id: string;
  status: string;
  text: string;
  choices?: string[];
  room_id?: string | null;
  created_at?: string;
  expires_at?: string;
  answer?: { choice?: string | null; text?: string | null; answered_at?: string | null } | null;
};

/** What a tool says about a question: status, the answer once there is one, and what to do next. */
export function describeQuestion(q: Question): string {
  const lines = [`question_id ${q.id}: ${q.status}`];
  if (q.status === 'answered' && q.answer) {
    const c = (q.answer.choice ?? '').trim();
    const t = (q.answer.text ?? '').trim();
    if (c) lines.push(`Choice: ${c}`);
    if (t) lines.push(`Answer: ${t}`);
    if (q.answer.answered_at) lines.push(`Answered at ${q.answer.answered_at}.`);
  } else if (q.status === 'open') {
    lines.push(
      `Waiting for the owner${q.expires_at ? ` (expires ${q.expires_at})` : ''}. ` +
        'Check again with grupr_question (wait_seconds up to 50), or carry on with other work and look later; your webhook gets "question_answered" if you have one.',
    );
  } else if (q.status === 'expired') {
    lines.push('Nobody answered within 7 days. Ask again only if you still need the decision.');
  }
  lines.push(`Question: ${q.text}`);
  if (q.choices && q.choices.length) lines.push(`Choices offered: ${q.choices.join(' | ')}`);
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one of the question tools. Errors (HubError from hubJSON) propagate to server.ts's handler. */
export async function callQuestionTool(
  name: string,
  args: Record<string, unknown>,
  hubJSON: HubJSON,
  opts: { pollMs?: number } = {},
): Promise<ToolResult> {
  if (name === 'grupr_ask_owner') {
    const body: Record<string, unknown> = { text: String(args.text ?? '') };
    if (Array.isArray(args.choices)) body.choices = args.choices.map((c) => String(c));
    const room = typeof args.room_id === 'string' && args.room_id ? args.room_id : typeof args.grupr_id === 'string' ? args.grupr_id : '';
    if (room) body.room_id = room;
    const res = await hubJSON<{ question: Question }>('/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: 'Asked. ' + describeQuestion(res.question) }] };
  }

  if (name === 'grupr_question') {
    const id = String(args.question_id ?? '');
    const path = `/questions/${encodeURIComponent(id)}`;
    const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, typeof args.wait_seconds === 'number' ? args.wait_seconds : 0));
    const until = Date.now() + wait * 1000;
    const poll = opts.pollMs ?? POLL_MS;
    let q = (await hubJSON<{ question: Question }>(path)).question;
    while (q.status === 'open' && Date.now() + poll <= until) {
      await sleep(poll);
      q = (await hubJSON<{ question: Question }>(path)).question;
    }
    return { content: [{ type: 'text', text: describeQuestion(q) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}
