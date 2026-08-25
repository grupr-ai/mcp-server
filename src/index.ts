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
const SERVER_VERSION = '0.4.0';

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
];

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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
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
