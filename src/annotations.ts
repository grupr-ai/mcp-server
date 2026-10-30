/**
 * Tool titles and behaviour hints (MCP tool annotations). Directories such
 * as Claude's connector directory read these to decide what to show and
 * what to confirm: a read-only tool runs without a prompt, a destructive
 * one asks first, an open-world one reaches outside Grupr.
 *
 * readOnlyHint   the tool changes nothing on Grupr
 * destructiveHint the tool may overwrite or remove something (default true
 *                 when readOnlyHint is false, so it is set explicitly)
 * idempotentHint  calling it again with the same arguments changes nothing more
 * openWorldHint   the tool talks to something outside Grupr (a webhook
 *                 receiver, a URL, an email recipient, the sandbox network)
 */
export interface ToolMeta {
  title: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function read(title: string, openWorld = false): ToolMeta {
  return { title, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld } };
}

function write(title: string, opts: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {}): ToolMeta {
  return {
    title,
    annotations: {
      readOnlyHint: false,
      destructiveHint: opts.destructive ?? false,
      idempotentHint: opts.idempotent ?? false,
      openWorldHint: opts.openWorld ?? false,
    },
  };
}

export const TOOL_META: Record<string, ToolMeta> = {
  grupr_rooms: read('List my rooms'),
  grupr_poll_messages: read('Read room messages'),
  grupr_wait_for_messages: read('Wait for new messages'),
  grupr_send_message: write('Post a message'),
  grupr_register_webhook: write('Set the wake webhook', { idempotent: true }),
  grupr_delete_webhook: write('Remove the wake webhook', { destructive: true, idempotent: true }),
  grupr_webhook_deliveries: read('Webhook delivery history'),
  grupr_test_webhook: write('Test the wake webhook', { openWorld: true }),
  grupr_workspace_info: read('Workspace status'),
  grupr_contracts: read('List task contracts'),
  grupr_contract: read('One task contract'),
  grupr_contract_traces: read('Pass/fail traces of a contract'),
  grupr_workspace_run: write('Run a command in the workspace', { destructive: true, openWorld: true }),
  grupr_workspace_result: read('Result of a workspace run'),
  grupr_workspace_files: read('List workspace files'),
  grupr_workspace_read: read('Read a workspace file'),
  grupr_workspace_write: write('Write a workspace file', { destructive: true, idempotent: true }),
  grupr_room_files: read('List Room Files'),
  grupr_room_file_read: read('Read a Room File'),
  grupr_workspace_publish: write('Publish a workspace file to Room Files'),
  grupr_workspace_fetch: write('Fetch a URL into the workspace', { openWorld: true }),
  grupr_workspace_summary: read('This week for the agent'),
  grupr_workspace_download: write('Download through a connection', { openWorld: true }),
  grupr_workspace_connection_request: write('Ask the owner for a connection'),
  grupr_workspace_connections: read('List connections'),
  grupr_workspace_schedule: write('Propose a routine'),
  grupr_workspace_schedules: read('List routines'),
  grupr_workspace_unschedule: write('Remove a routine', { destructive: true, idempotent: true }),
  grupr_workspace_schedule_runs: read('Routine run history'),
  grupr_workspace_recipes: read('List routine recipes'),
  grupr_workspace_recipe: write('Propose a recipe routine'),
  grupr_room_doc_write: write('Write a document to Room Files'),
  grupr_room_sheet_write: write('Write a sheet to Room Files'),
  grupr_mail_send: write('Send an email (owner-approved)', { openWorld: true }),
  grupr_mail_inbox: read('Mail inbox'),
  grupr_mail_read: read('Read an email'),
  grupr_mail_status: read('Mail status'),
};
