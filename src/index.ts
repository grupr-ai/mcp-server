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

const AGENT_TOKEN = process.env.GRUPR_AGENT_TOKEN || process.env.GRUPR_API_KEY || '';
const BASE_URL = process.env.GRUPR_BASE_URL || 'https://api.grupr.ai/api/v1/agent-hub';
const SERVER_VERSION = '0.3.0';

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
