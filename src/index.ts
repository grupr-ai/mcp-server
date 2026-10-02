#!/usr/bin/env node
/**
 * Grupr MCP Server
 *
 * Exposes Grupr's agent-hub API as MCP tools, so any MCP-compatible client
 * (Claude Desktop, Cursor, Zed, etc.) can drive an existing Grupr agent:
 * poll new messages, post replies, manage webhooks.
 *
 * Lifecycle:
 *   1. Create an agent under your user account (Grupr web app or POST /api/agents).
 *   2. Mint an agent token (web app or POST /api/v1/agent-hub/register).
 *   3. Set GRUPR_AGENT_TOKEN to that token and run this server.
 *
 * Installation:
 *   claude mcp add grupr --command "npx @grupr/mcp-server"
 *
 * Environment:
 *   GRUPR_AGENT_TOKEN  — required. Agent token from /agent-hub/register.
 *   GRUPR_API_KEY      — deprecated alias for GRUPR_AGENT_TOKEN. Use GRUPR_AGENT_TOKEN.
 *   GRUPR_BASE_URL     — override (defaults to https://api.grupr.ai/api/v1/agent-hub).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GruprClient, GruprAuthError, GruprError } from '@grupr/sdk';
import type { Message } from '@grupr/sdk';

const AGENT_TOKEN = process.env.GRUPR_AGENT_TOKEN || process.env.GRUPR_API_KEY || '';
const BASE_URL = process.env.GRUPR_BASE_URL || 'https://api.grupr.ai/api/v1/agent-hub';
const SERVER_VERSION = '0.11.0';

// ── Real-time wait tuning ───────────────────────────────
/** Default block duration for grupr_wait_for_messages. */
const DEFAULT_WAIT_SECONDS = 60;
/** Ceiling — most MCP clients time out a tool call well before this. */
const MAX_WAIT_SECONDS = 300;
/**
 * After the first message lands, keep collecting for a moment so a burst
 * (an agent posting several messages back to back) returns as one batch
 * instead of waking the caller once per message.
 */
const BURST_SETTLE_MS = 400;

if (!AGENT_TOKEN) {
  console.error(
    'GRUPR_AGENT_TOKEN is not set. Mint a token via /api/v1/agent-hub/register, then export GRUPR_AGENT_TOKEN before starting the MCP server.',
  );
  process.exit(1);
}

const client = new GruprClient({ agentToken: AGENT_TOKEN, baseUrl: BASE_URL });

// ── Tool definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'grupr_poll_messages',
    description:
      'Poll messages in a grupr this agent is assigned to. Returns chronological message history. Pass `after` (RFC3339 timestamp from a previous message\'s created_at) to get only newer messages — the standard pattern for incremental polling.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: {
          type: 'string',
          description: 'UUID of the grupr to poll.',
        },
        after: {
          type: 'string',
          description: 'RFC3339 timestamp — return only messages strictly after this time.',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (1-100). Default 50.',
        },
      },
      required: ['grupr_id'],
    },
  },
  {
    name: 'grupr_wait_for_messages',
    description:
      'Block until a new message arrives in a grupr, then return it — real-time push instead of timer polling. ' +
      'Pass `after` (the created_at of the last message you PROCESSED) and it returns as soon as anything newer exists, ' +
      'typically within ~2s of the message being posted. Returns immediately if messages after your cursor already exist. ' +
      'Returns an empty list if nothing arrives before `timeout_seconds` — that is normal; call again with the same cursor to keep waiting. ' +
      'This is the preferred way to follow a room: it replaces sleep-then-poll loops. ' +
      'CORRECTNESS: always pass your own processed cursor as `after` and advance it only after you have handled a message. ' +
      'The underlying delivery is a WebSocket with an HTTP backlog drain on every call, so anything missed while disconnected ' +
      '(including an API restart) is picked up by the next call — but only if your cursor is accurate. Never treat push as state.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: {
          type: 'string',
          description: 'UUID of the grupr to watch.',
        },
        after: {
          type: 'string',
          description:
            'RFC3339 timestamp — the created_at of the last message you processed. Return only messages strictly after it. Omit to wait for messages from now onward.',
        },
        timeout_seconds: {
          type: 'number',
          description: `How long to block before returning empty. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}. Keep it under your MCP client's tool timeout.`,
        },
      },
      required: ['grupr_id'],
    },
  },
  {
    name: 'grupr_send_message',
    description:
      "Send a message as this agent in a grupr it's assigned to. Billable. Markdown is supported in `content`.",
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'UUID of the target grupr.' },
        content: { type: 'string', description: 'Message body (markdown).' },
      },
      required: ['grupr_id', 'content'],
    },
  },
  {
    name: 'grupr_register_webhook',
    description:
      'Register an HTTPS webhook URL for this agent. The Grupr backend will POST event payloads (HMAC-signed with `secret`) to the URL when grupr events fire. Upsert semantics — one webhook per agent.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTPS endpoint that will receive event POSTs.',
        },
        secret: {
          type: 'string',
          description:
            'Optional shared secret. If set, the backend signs each delivery with HMAC-SHA256 and sends a Grupr-Signature header.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'grupr_delete_webhook',
    description: "Remove this agent's webhook registration.",
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Workspace (AgentOS, D-144) ─────────────────────────
  {
    name: 'grupr_workspace_info',
    description:
      "This agent's persistent workspace: a Linux sandbox that keeps its files between calls and pauses when idle. " +
      'Returns its state (none / running / paused / lost), root path (/home/user), last use and run count. ' +
      'The workspace is created on the first command or file operation.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'grupr_workspace_run',
    description:
      "Run a shell command in this agent's workspace. EVERY command needs a human decision first: an approval card " +
      'appears in the room you name in grupr_id (and on the owner\'s Grupr dashboard); the call blocks up to ~2 minutes ' +
      'for Approve/Deny. Approved → the command runs and you get exit_code, stdout, stderr. Denied → you get the reason; ' +
      'do not retry the same command, say so in the room. No answer in time → you get status "pending" with a run_id: the command ' +
      'RUNS THE MOMENT A HUMAN APPROVES and its result is posted into the room as you, so keep following the room ' +
      '(grupr_wait_for_messages) or call grupr_workspace_result with the run_id. Never re-submit a pending command. ' +
      'Standing permissions the owner has granted for this agent auto-approve (auto_approved: true). ' +
      'Commands run under /bin/sh in /home/user by default; files persist between calls; the sandbox pauses after ~5 idle minutes ' +
      'and resumes transparently (running processes do not survive a pause). Output is capped at 512 KB and scrubbed of credential shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command line (sh -c). Keep it to one purpose per call — that is what the human approves.' },
        cwd: { type: 'string', description: 'Working directory inside /home/user. Default /home/user.' },
        grupr_id: { type: 'string', description: 'UUID of the room the approval should appear in. Always pass the room you are working in.' },
        timeout_seconds: { type: 'number', description: 'Wall-clock cap for the command (default 60, max 300).' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'grupr_workspace_result',
    description:
      'Fetch a workspace run by run_id: its status (pending / running / done / failed / denied / cancelled / expired) and, once finished, exit_code, stdout and stderr. Use after grupr_workspace_run returned "pending".',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'The run_id from grupr_workspace_run.' } },
      required: ['run_id'],
    },
  },
  {
    name: 'grupr_workspace_files',
    description: 'List one directory of the workspace (name, type, size, modified). Paths are confined to /home/user.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to list. Default /home/user.' } },
    },
  },
  {
    name: 'grupr_workspace_read',
    description:
      'Read a file from the workspace. Text comes back as text; binary or oversized content comes back base64-encoded with a note. Files up to 10 MB.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path under /home/user, or relative to it.' } },
      required: ['path'],
    },
  },
  {
    name: 'grupr_workspace_write',
    description:
      'Write a text file into the workspace (parent directories are created). No approval is needed to write files; running them is what gets approved.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path under /home/user, or relative to it.' },
        content: { type: 'string', description: 'File contents (UTF-8).' },
      },
      required: ['path', 'content'],
    },
  },
  // ── Room Files (shared per-room store, D-144 inc. 3) ──
  {
    name: 'grupr_room_files',
    description:
      "List a grupr's shared Files: the durable store every member of the room sees (humans upload, agents publish). " +
      'Each entry has file_id, name (a path like reports/q3.md), size, content_type, version, who added it and when. ' +
      'The agent must be assigned to the grupr.',
    inputSchema: {
      type: 'object',
      properties: { grupr_id: { type: 'string', description: 'The grupr (room) id.' } },
      required: ['grupr_id'],
    },
  },
  {
    name: 'grupr_room_file_read',
    description:
      "Read one of a grupr's shared Files by file_id or name, as text you can reason about: Markdown, text, CSV, and the text of Word (.docx), " +
      'PowerPoint (.pptx) and PDF files; Excel (.xlsx) comes back sheet by sheet as CSV. Images and other binaries return a short description ' +
      '(or base64 when nothing better exists). To work on the raw file in the workspace instead, use grupr_workspace_fetch.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) id.' },
        file: { type: 'string', description: 'file_id or the name shown by grupr_room_files.' },
      },
      required: ['grupr_id', 'file'],
    },
  },
  {
    name: 'grupr_workspace_publish',
    description:
      "Copy a file from this agent's workspace into a grupr's shared Files so every member can download it. " +
      'Same name replaces the previous version. The room is told, as this agent. No approval is needed: publishing is a file write, not a command.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) to publish into; the agent must be assigned to it.' },
        path: { type: 'string', description: 'Workspace path of the file (absolute under /home/user, or relative to it).' },
        name: { type: 'string', description: 'Name inside the room, e.g. reports/q3.md. Defaults to the file name.' },
      },
      required: ['grupr_id', 'path'],
    },
  },
  {
    name: 'grupr_workspace_fetch',
    description:
      "Copy one of a grupr's shared Files into this agent's workspace. Default destination is /home/user/rooms/<grupr_id>/<name>; " +
      'pass path to choose another (a trailing slash means a directory).',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) id.' },
        file: { type: 'string', description: 'file_id or the name shown by grupr_room_files.' },
        path: { type: 'string', description: 'Destination in the workspace (optional).' },
      },
      required: ['grupr_id', 'file'],
    },
  },
  // ── Routines (D-144 inc. 13) ──
  {
    name: 'grupr_workspace_schedule',
    description:
      "Propose a routine: one shell command that runs in this agent's workspace on a cron, with the result posted in the room each time. " +
      "A human must approve the proposal once (an approval card appears in the room you name and on the owner's dashboard); after that the " +
      'routine runs on its own without asking again, so only propose commands you would be happy to see run unattended. Destructive commands ' +
      'cannot be scheduled, the minimum interval is 5 minutes, and an agent may have at most 20 routines. Returns pending (card raised — do not ' +
      're-submit; the room is told when it is created) or created (a standing rule allowed it).',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) the routine belongs to and posts into; the agent must be assigned to it.' },
        cmd: { type: 'string', description: 'The shell command, exactly as grupr_workspace_run would run it.' },
        cron: {
          type: 'string',
          description: 'Five-field cron (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" = weekdays 08:00; or @hourly / @daily / @weekly / @monthly.',
        },
        timezone: { type: 'string', description: 'IANA timezone the cron is read in (default UTC), e.g. America/New_York.' },
        label: { type: 'string', description: 'Short human label, e.g. "Morning report" (≤ 80 chars).' },
        cwd: { type: 'string', description: 'Working directory (default /home/user).' },
        timeout_seconds: { type: 'number', description: 'Per-run wall clock, up to 300 (default 300).' },
      },
      required: ['grupr_id', 'cmd', 'cron'],
    },
  },
  {
    name: 'grupr_workspace_schedules',
    description: "List this agent's routines: schedule, timezone, room, enabled, next and last run, run and failure counts.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'grupr_workspace_unschedule',
    description: "Remove one of this agent's routines by schedule_id. The room is told. (Owners can also pause or remove routines from the agent page.)",
    inputSchema: {
      type: 'object',
      properties: { schedule_id: { type: 'string' } },
      required: ['schedule_id'],
    },
  },
  // ── Documents (D-144 inc. 4) ──
  {
    name: 'grupr_room_doc_write',
    description:
      "Write a document into a grupr's shared Files from Markdown. Grupr renders it to <name>.md, <name>.html, a real Word file <name>.docx and a PDF <name>.pdf " +
      '(headings, bold/italic/code/links, bullet and numbered lists, tables, code blocks, quotes). Members read it in the room (click the file) ' +
      'or download the .docx. Same name replaces. The room is told once, as this agent. Prefer this over writing files in the workspace when a ' +
      'human needs to read the result.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) id; the agent must be assigned to it.' },
        name: { type: 'string', description: 'Document name without extension, folders allowed (e.g. reports/q3-review). Defaults to a slug of the title / first heading.' },
        title: { type: 'string', description: 'Document title (defaults to the first # heading).' },
        markdown: { type: 'string', description: 'The document body in Markdown (≤ 1 MB).' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['md', 'html', 'docx', 'pdf'] },
          description: 'Which files to produce. Default: md, html, docx, pdf.',
        },
      },
      required: ['grupr_id', 'markdown'],
    },
  },
  {
    name: 'grupr_room_sheet_write',
    description:
      "Write a spreadsheet into a grupr's shared Files from a table spec: Grupr produces <name>.xlsx (bold frozen header, autofilter, numbers as " +
      'numbers) and <name>.csv of the first sheet. Up to 20 sheets / 256 columns / 200k cells. Same name replaces. The room is told once, as this agent.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) id; the agent must be assigned to it.' },
        name: { type: 'string', description: 'Workbook name without extension, folders allowed. Defaults to the first sheet name.' },
        sheets: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet tab name (≤ 31 chars).' },
              columns: { type: 'array', items: { type: 'string' }, description: 'Header row.' },
              rows: {
                type: 'array',
                items: { type: 'array', items: {} },
                description: 'Data rows; values are numbers, strings, booleans or null. Numeric strings become numbers.',
              },
            },
            required: ['name', 'columns'],
          },
        },
        formats: { type: 'array', items: { type: 'string', enum: ['xlsx', 'csv'] }, description: 'Default: both.' },
      },
      required: ['grupr_id', 'sheets'],
    },
  },
  // ── Mail (D-144 inc. 5, outbound) ──
  {
    name: 'grupr_mail_send',
    description:
      'Email someone on behalf of the room. NOTHING is sent until a human approves: an approval card with the recipients, subject, ' +
      'preview and attachments appears in the grupr you name. The call waits up to ~2 minutes; if approved it sends and returns ' +
      '"sent", if denied you get the reason (do not retry), otherwise it returns "pending" and the mail goes out the moment someone ' +
      'approves (receipt posted in the room; check with grupr_mail_status). The message leaves as "<agent name> via Grupr" from the ' +
      'shared agent address, with a footer naming the agent and its owner. Attachments must be files in that grupr\'s shared Files ' +
      '(by name or file_id) — write them first with grupr_room_doc_write / grupr_room_sheet_write / grupr_workspace_publish.',
    inputSchema: {
      type: 'object',
      properties: {
        grupr_id: { type: 'string', description: 'The grupr (room) this mail is sent from; the agent must be assigned to it.' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipients ("Name <addr>" or bare addresses). Max 10 with cc.' },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        markdown: { type: 'string', description: 'Body in Markdown (rendered to HTML + plain text).' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Room File names or ids (max 5, 8 MB total).' },
        in_reply_to: { type: 'string', description: 'mail_id of an inbound mail you are answering (from grupr_mail_inbox). Threads the reply and prefixes "Re:".' },
      },
      required: ['grupr_id', 'to', 'subject', 'markdown'],
    },
  },
  {
    name: 'grupr_mail_inbox',
    description:
      "Mail that arrived FOR this agent (people replying to its mail, or writing to its address). Each inbound mail was also posted into a room as \"📨 Mail for <agent>\", so you usually see it there first; use this to list or re-check. " +
      'Returns mail_id, from, subject, when, which room it landed in, and attachment names (saved in that room\'s Files under mail/). Read the full text with grupr_mail_read; answer with grupr_mail_send and in_reply_to.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many (default 10, max 100).' } },
    },
  },
  {
    name: 'grupr_mail_read',
    description: 'Full text of one mail (inbound or sent) by mail_id: headers, body text, attachments, status.',
    inputSchema: {
      type: 'object',
      properties: { mail_id: { type: 'string' } },
      required: ['mail_id'],
    },
  },
  {
    name: 'grupr_mail_status',
    description: 'Status of a mail this agent asked to send: pending / sending / sent / failed / denied / cancelled / expired, with the provider id or error.',
    inputSchema: {
      type: 'object',
      properties: { mail_id: { type: 'string' } },
      required: ['mail_id'],
    },
  },
];

// ── Workspace HTTP (raw fetch; the SDK predates these endpoints) ───────────

class HubError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public approvalId?: string,
  ) {
    super(message);
  }
}

async function hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AGENT_TOKEN}`,
    'User-Agent': `grupr-mcp-server/${SERVER_VERSION}`,
    ...((init.headers as Record<string, string>) || {}),
  };
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

async function hubJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await hubFetch(path, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = body?.errors?.[0];
    throw new HubError(
      res.status,
      e?.code || 'error',
      e?.message || body?.error || `HTTP ${res.status}`,
      res.headers.get('x-approval-id') || undefined,
    );
  }
  return (body?.data ?? body) as T;
}

// previewToText flattens the api's structured preview into text an agent can
// read. Returns null when the raw download is the better answer.
function previewToText(p: any): string | null {
  const head = `${p.name ?? ''} (${p.content_type ?? ''}, ${p.size ?? '?'} B)`;
  const csv = (rows: string[][]) =>
    rows
      .map((r) => r.map((c) => (/[",\n]/.test(c ?? '') ? `"${String(c ?? '').replace(/"/g, '""')}"` : (c ?? ''))).join(','))
      .join('\n');
  switch (p.kind) {
    case 'markdown': {
      const src = p.source ? ` — text extracted from ${String(p.source).toUpperCase()}; formatting approximate` : '';
      const body = typeof p.text === 'string' && p.text ? p.text : blocksToText(p.blocks ?? []);
      return `${head}${src}${p.truncated ? ' [truncated]' : ''}\n\n${body}`;
    }
    case 'table':
      return `${head}${p.truncated ? ' [truncated]' : ''}\n\n${csv([p.header ?? [], ...(p.rows ?? [])])}`;
    case 'workbook': {
      const parts = (p.sheets ?? []).map(
        (sh: any) => `### ${sh.name}${sh.truncated ? ' [truncated]' : ''}\n${csv([sh.header ?? [], ...(sh.rows ?? [])])}`,
      );
      return `${head} — ${(p.sheets ?? []).length} sheet(s)\n\n${parts.join('\n\n')}`;
    }
    case 'text':
      return `${head}${p.truncated ? ' [truncated]' : ''}\n\n${p.text ?? ''}`;
    case 'pdf':
      return typeof p.text === 'string' && p.text
        ? `${head} — text extracted from PDF; layout not preserved\n\n${p.text}`
        : `${head} — a PDF whose text could not be extracted (scanned or custom fonts). Download it with grupr_workspace_fetch if you need the bytes.`;
    case 'image':
      return `${head} — an image. Fetch it into the workspace with grupr_workspace_fetch to process it.`;
    default:
      return null;
  }
}

function blocksToText(blocks: any[]): string {
  const spans = (ss: any[]) => (ss ?? []).map((s) => (s.break ? '\n' : s.text ?? '')).join('');
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push('#'.repeat(b.level ?? 1) + ' ' + spans(b.spans));
        break;
      case 'paragraph':
      case 'quote':
        out.push(spans(b.spans));
        break;
      case 'code':
        out.push('```\n' + (b.text ?? '') + '\n```');
        break;
      case 'list':
        out.push((b.items ?? []).map((it: any, i: number) => `${b.ordered ? i + 1 + '.' : '-'} ${spans(it.spans)}`).join('\n'));
        break;
      case 'table':
        out.push([b.header ?? [], ...(b.rows ?? [])].map((r: any[]) => '| ' + r.map((c) => spans(c.spans)).join(' | ') + ' |').join('\n'));
        break;
      case 'hr':
        out.push('---');
        break;
    }
  }
  return out.join('\n\n');
}

function textOrBase64(buf: Buffer): { text?: string; base64?: string; note?: string } {
  const isText = !buf.subarray(0, 8000).includes(0);
  if (isText && buf.length <= 200 * 1024) {
    return { text: buf.toString('utf8') };
  }
  return {
    base64: buf.toString('base64'),
    note: isText
      ? 'Text file over 200 KB returned as base64.'
      : 'Binary content returned as base64.',
  };
}

// ── Real-time wait ──────────────────────────────────────
//
// Wraps the SDK's WebSocket-backed streamEvents() in a bounded, blocking
// call so any MCP client can follow a room in real time without writing a
// WS client of its own.
//
// Why a blocking tool rather than MCP notifications: an MCP server can push
// notifications, but no current client reliably turns an unsolicited
// notification into a new agent turn — so a notification would arrive and
// nothing would act on it. A tool call is the one shape every client
// already knows how to wake up on, so that is the paved path.
//
// The push/poll split the platform depends on is enforced here rather than
// left to the caller: streamEvents drains the HTTP backlog after `since`
// before it opens the socket, so every call reconciles first and pushes
// second. Anything missed while disconnected — including an API restart,
// which the single-instance in-process hub does not replay — is recovered
// by the next call's drain. Push is only ever the wake; the returned
// messages come from a read that is authoritative on its own.
async function waitForMessages(
  gruprId: string,
  after: string | undefined,
  timeoutMs: number,
): Promise<{ messages: Message[]; reason: 'message' | 'timeout' }> {
  const controller = new AbortController();
  const collected: Message[] = [];
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for await (const msg of client.streamEvents(gruprId, {
      since: after,
      signal: controller.signal,
    })) {
      collected.push(msg);
      // First hit starts a short window so a burst returns together.
      if (burstTimer === null) {
        burstTimer = setTimeout(() => controller.abort(), BURST_SETTLE_MS);
      }
    }
  } catch (err) {
    // A deliberate abort is how we stop the iterable; only a genuine
    // failure should surface to the caller.
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(deadline);
    if (burstTimer !== null) clearTimeout(burstTimer);
  }

  // Order defensively: the backlog drain and the socket are different
  // sources, and a burst can interleave.
  collected.sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.message_id.localeCompare(b.message_id);
  });

  // Dedupe by message_id — a reconnect inside streamEvents can re-drain.
  const seen = new Set<string>();
  const messages = collected.filter((m) => {
    if (seen.has(m.message_id)) return false;
    seen.add(m.message_id);
    return true;
  });

  return { messages, reason: messages.length > 0 ? 'message' : 'timeout' };
}

// ── Server setup ────────────────────────────────────────

const server = new Server(
  { name: 'grupr-mcp-server', version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'grupr_poll_messages': {
        const result = await client.pollMessages(String(args.grupr_id), {
          after: args.after as string | undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: result.count,
                  next_cursor: result.nextCursor,
                  messages: result.data,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'grupr_wait_for_messages': {
        const gruprId = String(args.grupr_id);
        const after = typeof args.after === 'string' ? args.after : undefined;
        const requested =
          typeof args.timeout_seconds === 'number'
            ? args.timeout_seconds
            : DEFAULT_WAIT_SECONDS;
        const waitMs =
          Math.min(Math.max(1, requested), MAX_WAIT_SECONDS) * 1000;

        const startedAt = Date.now();
        const { messages, reason } = await waitForMessages(
          gruprId,
          after,
          waitMs,
        );
        const waitedMs = Date.now() - startedAt;

        // next_cursor is a suggestion, not state: it is only safe to adopt
        // once the caller has actually processed every message returned.
        const nextCursor =
          messages.length > 0
            ? messages[messages.length - 1].created_at
            : (after ?? null);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: messages.length,
                  reason,
                  waited_ms: waitedMs,
                  next_cursor: nextCursor,
                  messages,
                  note:
                    messages.length === 0
                      ? 'No new messages before timeout. Call again with the SAME cursor.'
                      : 'Advance your cursor to next_cursor only after processing every message above.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'grupr_send_message': {
        const msg = await client.sendMessage(
          String(args.grupr_id),
          String(args.content),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Posted. message_id=${msg.message_id} created_at=${msg.created_at}`,
            },
          ],
        };
      }

      case 'grupr_register_webhook': {
        const wh = await client.registerWebhook({
          url: String(args.url),
          secret: typeof args.secret === 'string' ? args.secret : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Webhook registered. webhook_id=${wh.webhook_id} active=${wh.is_active}`,
            },
          ],
        };
      }

      case 'grupr_delete_webhook': {
        await client.deleteWebhook();
        return {
          content: [{ type: 'text', text: 'Webhook removed.' }],
        };
      }

      case 'grupr_workspace_info': {
        const info = await hubJSON<Record<string, unknown>>('/workspace');
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      }

      case 'grupr_workspace_run': {
        const res = await hubJSON<Record<string, unknown>>('/workspace/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: String(args.cmd),
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            grupr_id: typeof args.grupr_id === 'string' ? args.grupr_id : undefined,
            timeout_seconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined,
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      }

      case 'grupr_workspace_result': {
        const run = await hubJSON<Record<string, unknown>>(`/workspace/runs/${encodeURIComponent(String(args.run_id))}`);
        return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
      }

      case 'grupr_workspace_files': {
        const p = typeof args.path === 'string' && args.path ? args.path : '/home/user';
        const res = await hubFetch(`/workspace/files?path=${encodeURIComponent(p)}`);
        const body: any = await res.json().catch(() => null);
        if (!res.ok) {
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify({ path: body?.meta?.path ?? p, entries: body?.data ?? [] }, null, 2) },
          ],
        };
      }

      case 'grupr_workspace_read': {
        const p = String(args.path);
        const res = await hubFetch(`/workspace/file?path=${encodeURIComponent(p)}`);
        if (!res.ok) {
          const body: any = await res.json().catch(() => null);
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { content: [{ type: 'text', text: JSON.stringify({ path: p, size: buf.length, ...textOrBase64(buf) }, null, 2) }] };
      }

      case 'grupr_room_files': {
        const gid = encodeURIComponent(String(args.grupr_id));
        const res = await hubFetch(`/grups/${gid}/files`);
        const body: any = await res.json().catch(() => null);
        if (!res.ok) {
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { files: body?.data ?? [], used_bytes: body?.meta?.used_bytes, quota_bytes: body?.meta?.quota_bytes },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'grupr_room_file_read': {
        const gid = encodeURIComponent(String(args.grupr_id));
        const ref = String(args.file);
        const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
        // Documents first: the api's preview carries extracted text for
        // Word / PowerPoint / PDF, sheets for Excel, blocks for Markdown.
        let fileId = isId ? ref : '';
        if (!fileId) {
          const lr = await hubFetch(`/grups/${gid}/files`);
          const lb: any = await lr.json().catch(() => null);
          const hit = (lb?.data ?? []).find((f: any) => f.name === ref || f.name === ref.replace(/^\/+/, ''));
          if (hit) fileId = hit.file_id;
        }
        if (fileId) {
          const pr = await hubFetch(`/grups/${gid}/files/${fileId}/preview`);
          const pb: any = await pr.json().catch(() => null);
          if (pr.ok && pb?.data) {
            const rendered = previewToText(pb.data);
            if (rendered !== null) {
              return { content: [{ type: 'text', text: rendered }] };
            }
          }
        }
        const res = await hubFetch(isId ? `/grups/${gid}/files/${ref}` : `/grups/${gid}/file?name=${encodeURIComponent(ref)}`);
        if (!res.ok) {
          const body: any = await res.json().catch(() => null);
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { file: ref, size: buf.length, content_type: res.headers.get('content-type') || undefined, ...textOrBase64(buf) },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'grupr_workspace_publish': {
        const f = await hubJSON<Record<string, unknown>>('/workspace/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grupr_id: String(args.grupr_id),
            path: String(args.path),
            name: typeof args.name === 'string' && args.name ? args.name : undefined,
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Published ${f.name ?? '?'} (${f.size ?? '?'} bytes, v${f.version ?? 1}) to the room's Files. file_id ${f.file_id ?? '?'}.`,
            },
          ],
        };
      }

      case 'grupr_workspace_fetch': {
        const ref = String(args.file);
        const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
        const r = await hubJSON<Record<string, unknown>>('/workspace/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grupr_id: String(args.grupr_id),
            file_id: isId ? ref : undefined,
            name: isId ? undefined : ref,
            path: typeof args.path === 'string' && args.path ? args.path : undefined,
          }),
        });
        return { content: [{ type: 'text', text: `Fetched ${r.name ?? ref} (${r.size ?? '?'} bytes) into ${r.path ?? '?'}.` }] };
      }

      case 'grupr_workspace_schedule': {
        const res = await hubFetch('/workspace/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grupr_id: String(args.grupr_id),
            cmd: String(args.cmd),
            cron: String(args.cron),
            timezone: typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined,
            label: typeof args.label === 'string' && args.label ? args.label : undefined,
            cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined,
            timeout_seconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined,
          }),
        });
        const text = await res.text();
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        if (!res.ok) {
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`);
        }
        const d = body?.data ?? {};
        if (res.status === 202 || d.status === 'pending') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Routine proposed — approval ${d.approval_id ?? '?'} is waiting for a member. Do not re-submit. ` +
                  'When someone approves, the routine is created and the room is told; if they deny, nothing is scheduled.',
              },
            ],
          };
        }
        const sch = d.schedule ?? d;
        return {
          content: [
            {
              type: 'text',
              text: `Routine created (a standing rule allowed it): schedule_id ${sch.schedule_id ?? '?'}, ${sch.cron ?? ''} ${sch.timezone ?? ''}, next run ${sch.next_run_at ?? '?'}.`,
            },
          ],
        };
      }

      case 'grupr_workspace_schedules': {
        const list = await hubJSON<Record<string, unknown>[]>('/workspace/schedules');
        if (!Array.isArray(list) || list.length === 0) {
          return { content: [{ type: 'text', text: 'No routines. Propose one with grupr_workspace_schedule.' }] };
        }
        const lines = list.map(
          (r) =>
            `- ${r.schedule_id} · ${r.label ? `${r.label}: ` : ''}\`${r.cmd}\` · ${r.cron} ${r.timezone} · room ${r.grupr_id} · ` +
            `${r.enabled ? 'on' : 'paused'} · next ${r.next_run_at ?? '—'} · last ${r.last_run_at ? `${r.last_run_at} (${r.last_status}${typeof r.last_exit_code === 'number' ? `, exit ${r.last_exit_code}` : ''})` : 'never'} · ` +
            `${r.runs ?? 0} runs, ${r.failures ?? 0} failed`,
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'grupr_workspace_unschedule': {
        await hubJSON<Record<string, unknown>>(`/workspace/schedules/${encodeURIComponent(String(args.schedule_id))}`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: 'Routine removed; the room has been told.' }] };
      }

      case 'grupr_room_doc_write': {
        const gid = encodeURIComponent(String(args.grupr_id));
        const r = await hubJSON<{ base?: string; title?: string; files?: { name: string; size: number; version: number; file_id: string }[] }>(
          `/grups/${gid}/documents`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: typeof args.name === 'string' ? args.name : undefined,
              title: typeof args.title === 'string' ? args.title : undefined,
              markdown: String(args.markdown ?? ''),
              formats: Array.isArray(args.formats) ? args.formats : undefined,
            }),
          },
        );
        const files = (r.files ?? []).map((f) => `${f.name} (${f.size} B, v${f.version}, ${f.file_id})`).join('; ');
        return { content: [{ type: 'text', text: `Wrote ${r.base ?? '?'} to the room's Files: ${files}.` }] };
      }

      case 'grupr_room_sheet_write': {
        const gid = encodeURIComponent(String(args.grupr_id));
        const r = await hubJSON<{ base?: string; files?: { name: string; size: number; version: number; file_id: string }[] }>(`/grups/${gid}/sheets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: typeof args.name === 'string' ? args.name : undefined,
            sheets: args.sheets,
            formats: Array.isArray(args.formats) ? args.formats : undefined,
          }),
        });
        const files = (r.files ?? []).map((f) => `${f.name} (${f.size} B, v${f.version}, ${f.file_id})`).join('; ');
        return { content: [{ type: 'text', text: `Wrote ${r.base ?? '?'} to the room's Files: ${files}.` }] };
      }

      case 'grupr_mail_send': {
        const res = await hubFetch('/mail/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grupr_id: String(args.grupr_id),
            to: Array.isArray(args.to) ? args.to : [String(args.to ?? '')],
            cc: Array.isArray(args.cc) ? args.cc : undefined,
            subject: String(args.subject ?? ''),
            markdown: String(args.markdown ?? ''),
            attachments: Array.isArray(args.attachments) ? args.attachments : undefined,
            in_reply_to: typeof args.in_reply_to === 'string' && args.in_reply_to ? args.in_reply_to : undefined,
          }),
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok) {
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        const d = body?.data ?? body;
        if (res.status === 202 || d?.status === 'pending') {
          return {
            content: [
              {
                type: 'text',
                text: `Mail ${d?.mail_id ?? '?'} is awaiting a human decision (approval ${d?.approval_id ?? '?'}). It sends the moment someone approves and the receipt is posted in the room. Do not re-send; check grupr_mail_status or watch the room.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Mail ${d?.mail_id ?? '?'} ${d?.status ?? '?'}${d?.provider_id ? ` (provider id ${d.provider_id})` : ''}${d?.auto_approved ? ' — auto-approved by a standing rule' : ''}. To: ${(d?.to ?? []).join(', ')}. Subject: ${d?.subject ?? ''}.`,
            },
          ],
        };
      }

      case 'grupr_mail_inbox': {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 10;
        const res = await hubFetch(`/mail?direction=in&limit=${limit}`);
        const body: any = await res.json().catch(() => null);
        if (!res.ok) {
          const e = body?.errors?.[0];
          throw new HubError(res.status, e?.code || 'error', e?.message || `HTTP ${res.status}`);
        }
        const items = (body?.data ?? []).map((m: any) => ({
          mail_id: m.mail_id,
          from: m.from,
          subject: m.subject,
          received_at: m.sent_at || m.created_at,
          grupr_id: m.grupr_id,
          in_reply_to: m.in_reply_to,
          attachments: (m.attachments ?? []).map((a: any) => a.name),
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ address: body?.meta?.address || null, inbound_enabled: body?.meta?.inbound_enabled ?? null, mail: items }, null, 2),
            },
          ],
        };
      }

      case 'grupr_mail_read': {
        const m = await hubJSON<Record<string, unknown>>(`/mail/${encodeURIComponent(String(args.mail_id))}`);
        return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
      }

      case 'grupr_mail_status': {
        const m = await hubJSON<Record<string, unknown>>(`/mail/${encodeURIComponent(String(args.mail_id))}`);
        return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
      }

      case 'grupr_workspace_write': {
        const p = String(args.path);
        const res = await hubJSON<Record<string, unknown>>(`/workspace/file?path=${encodeURIComponent(p)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: String(args.content ?? ''),
        });
        return { content: [{ type: 'text', text: `Wrote ${res.size ?? '?'} bytes to ${res.path ?? p}.` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    if (err instanceof HubError) {
      const hint =
        err.code === 'command_denied' || err.code === 'mail_denied'
          ? ' The human said no — do not retry; explain in the room instead.'
          : err.code === 'approval_timeout'
            ? ' Nobody decided in time and the request was cancelled. Ask in the room, then call again.'
            : err.status === 503
              ? ' Workspaces are not enabled on this Grupr server.'
              : '';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Grupr ${err.status} ${err.code}: ${err.message}.${hint}${err.approvalId ? ` (approval ${err.approvalId})` : ''}`,
          },
        ],
      };
    }
    if (err instanceof GruprAuthError) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Grupr authentication failed. Check GRUPR_AGENT_TOKEN — the token may be revoked or expired. Mint a new one via POST /api/v1/agent-hub/register with your user JWT.',
          },
        ],
      };
    }
    if (err instanceof GruprError) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Grupr ${err.status} ${err.code}: ${err.message}`,
          },
        ],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Grupr error: ${msg}` }],
    };
  }
});

// ── Run ────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Grupr MCP server ${SERVER_VERSION} ready. Base: ${BASE_URL}`);
}

main().catch((err) => {
  console.error('Grupr MCP server failed to start:', err);
  process.exit(1);
});
