import { Logger, NotFoundException } from '@nestjs/common';
import type { AgentToolDefinition } from '../maestro.types';
import type { Capability } from '../../workspace-members/role-capabilities';
import type { WorkspaceAccessService } from '../../workspace-members/workspace-access.service';

/**
 * What each Maestro tool needs the caller to be allowed to do.
 *
 * 'read' tools only look things up (or hand the user a button / a question);
 * conversation creation already proved the caller belongs to the workspace.
 * Every other entry is a WRITE — it creates, schedules, publishes or deletes
 * something, or sends a message through a channel — and runs the same
 * capability check as the REST route that does the same thing.
 *
 * Keep this in step with the tool set: capability-gate.spec fails on a tool
 * with no entry here and on an entry whose tool no longer exists.
 */
export const TOOL_ACCESS: Record<string, Capability | 'read'> = {
  // user / workspace
  get_user_profile: 'read',
  get_workspace_info: 'read',
  // posts
  list_posts: 'read',
  get_post: 'read',
  publish_post: 'posts:publish',
  // planner
  list_scheduled: 'read',
  get_schedule_summary: 'read',
  // campaigns (read-only today; a campaign write tool must be 'posts:publish')
  list_campaigns: 'read',
  get_campaign: 'read',
  // library
  search_library: 'read',
  get_library_item: 'read',
  create_template: 'posts:draft',
  create_snippet: 'posts:draft',
  save_link: 'posts:draft',
  // channels. connect_channel only offers the user a button; the connection
  // itself is made by the user's own call to a channels:manage route.
  list_channels: 'read',
  get_channel_stats: 'read',
  connect_channel: 'read',
  // inbox
  get_inbox_summary: 'read',
  list_conversations: 'read',
  get_conversation: 'read',
  // discord
  list_discord_channels: 'read',
  read_discord_messages: 'read',
  list_discord_dm_contacts: 'read',
  send_discord_message: 'inbox:reply',
  send_discord_dm: 'inbox:reply',
  delete_discord_message: 'inbox:reply',
  create_discord_channel: 'channels:manage',
  // slack
  list_slack_channels: 'read',
  read_slack_messages: 'read',
  list_slack_members: 'read',
  send_slack_message: 'inbox:reply',
  send_slack_dm: 'inbox:reply',
  delete_slack_message: 'inbox:reply',
  create_slack_channel: 'channels:manage',
  // telegram
  list_telegram_chats: 'read',
  read_telegram_messages: 'read',
  send_telegram_message: 'inbox:reply',
  // whatsapp
  list_whatsapp_chats: 'read',
  read_whatsapp_messages: 'read',
  send_whatsapp_message: 'inbox:reply',
  // lookups with no workspace data
  search_media: 'read',
  web_search: 'read',
  navigate_to: 'read',
  ask_user: 'read',
};

/** What an unclassified tool is held to: the strictest write right. */
const UNCLASSIFIED: Capability = 'posts:publish';

const logger = new Logger('MaestroCapabilityGate');

/**
 * Wrap every tool so a WRITE runs the caller's capability check first.
 *
 * Done on the handler, which every runtime and the approval path call, so a
 * confirm card is refused up front and an approved action is re-checked when
 * it actually runs — the role may have changed in between.
 *
 * The refusal is thrown as an ordinary Error: runTool turns it into an error
 * result the model reads and relays, instead of ending the turn.
 */
export function gateTools(
  tools: AgentToolDefinition[],
  access: Pick<WorkspaceAccessService, 'assertCan'>,
): AgentToolDefinition[] {
  return tools.map((tool) => {
    const known = TOOL_ACCESS[tool.name];
    if (known === undefined) {
      logger.warn(
        `Tool "${tool.name}" has no TOOL_ACCESS entry; requiring ${UNCLASSIFIED}`,
      );
    }
    const required = known ?? UNCLASSIFIED;
    if (required === 'read') return tool;

    return {
      ...tool,
      handler: async (args, ctx) => {
        try {
          await access.assertCan(ctx.workspaceId, ctx.userId, required);
        } catch (err) {
          if (err instanceof NotFoundException) {
            throw new Error(
              `Your role in this workspace does not allow this action (${tool.name}). Ask a workspace admin to change your role.`,
            );
          }
          throw err;
        }
        return tool.handler(args, ctx);
      },
    };
  });
}
