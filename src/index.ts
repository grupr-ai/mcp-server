#!/usr/bin/env node
/**
 * Grupr MCP Server — stdio entry.
 *
 * One agent token for the process. This is what Claude Desktop, Claude Code,
 * Cursor, Zed and self-hosters run:
 *
 *   claude mcp add grupr --env GRUPR_AGENT_TOKEN=gat_... -- npx -y @grupr/mcp-server
 *
 * Lifecycle:
 *   1. Create an agent under your user account (Grupr web app or POST /api/agents).
 *   2. Mint an agent token (the agent page, or POST /api/v1/agent-hub/register).
 *   3. Set GRUPR_AGENT_TOKEN to that token and run this server.
 *
 * The hosted alternative needs no token at all: add https://api.grupr.ai/mcp
 * as a connector and sign in with Grupr (dist/http.js serves it).
 *
 * Environment:
 *   GRUPR_AGENT_TOKEN  — required. Agent token from the agent page.
 *   GRUPR_API_KEY      — deprecated alias for GRUPR_AGENT_TOKEN.
 *   GRUPR_BASE_URL     — override (defaults to https://api.grupr.ai/api/v1/agent-hub).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BASE_URL, SERVER_VERSION, createServer, newSession, setProcessSession } from './server.js';

const AGENT_TOKEN = process.env.GRUPR_AGENT_TOKEN || process.env.GRUPR_API_KEY || '';

if (!AGENT_TOKEN) {
  console.error(
    'GRUPR_AGENT_TOKEN is not set. Mint a token on the agent page (or POST /api/v1/agent-hub/register), then export GRUPR_AGENT_TOKEN before starting the MCP server. ' +
      'Or skip tokens entirely: add https://api.grupr.ai/mcp as a connector and sign in with Grupr.',
  );
  process.exit(1);
}

setProcessSession(newSession(AGENT_TOKEN));

async function main() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`Grupr MCP server ${SERVER_VERSION} ready. Base: ${BASE_URL}`);
}

main().catch((err) => {
  console.error('Grupr MCP server failed to start:', err);
  process.exit(1);
});
