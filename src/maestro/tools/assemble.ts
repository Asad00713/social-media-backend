import type { AgentToolDefinition } from '../maestro.types';
import type { UsersService } from '../../users/users.service';
import type { WorkspaceService } from '../../workspace/workspace.service';
import type { UnsplashService } from '../../channels/services/unsplash.service';
import type { PexelsService } from '../../pexels/pexels.service';
import type { TavilyService } from '../../ai/services/tavily.service';
import type { DiscordService } from '../../channels/services/discord.service';
import type { SlackService } from '../../channels/services/slack.service';
import type { InboxService } from '../../inbox/inbox.service';
import type { InboxToolDeps } from './inbox.tools';
import type { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import type { DripService } from '../../drips/drip.service';
import type { PostService } from '../../posts/services/post.service';
import type { ChannelService } from '../../channels/services/channel.service';
import type { CampaignsService } from '../../campaigns/campaigns.service';
import { createUserTools } from './user.tools';
import { createMediaTools } from './media.tools';
import { createInteractionTools } from './interaction.tools';
import { createNavigateTools } from './navigate.tools';
import { createWebTools } from './web.tools';
import { createDiscordTools } from './discord.tools';
import { createSlackTools } from './slack.tools';
import { createTelegramTools } from './telegram.tools';
import { createWhatsAppTools } from './whatsapp.tools';
import { createPostTools } from './post.tools';
import { createChannelTools } from './channel.tools';
import { createCampaignTools } from './campaign.tools';
import { createLibraryTools, type LibraryDeps } from './library.tools';
import { createInboxTools } from './inbox.tools';
import { createPlannerTools } from './planner.tools';

/** Every service the Maestro tool factories close over. */
export interface MaestroToolDeps {
  users: UsersService;
  workspaces: WorkspaceService;
  unsplash: UnsplashService;
  pexels: PexelsService;
  tavily: TavilyService;
  discord: DiscordService;
  slack: SlackService;
  inbox: InboxService;
  /** Conversation-model services behind the inbox read tools. */
  conversations: InboxToolDeps;
  posts: PostService;
  channels: ChannelService;
  campaigns: CampaignsService;
  scheduledMessages: ScheduledMessagesService;
  drips: DripService;
  library: LibraryDeps;
}

export interface MaestroToolOptions {
  confirmBeforeSend: boolean;
  webSearchEnabled: boolean;
  /**
   * Whether the caller has a UI to navigate. False on the bridges, where
   * "I have opened Billing for you" would be a lie — there is no page there.
   */
  canNavigate?: boolean;
}

/**
 * The full tool set for one turn, ungated.
 *
 * Lives apart from MaestroService so the access-classification spec can build
 * the very same list the service does: a tool added here without an entry in
 * TOOL_ACCESS fails that spec instead of shipping unclassified.
 */
export function assembleMaestroTools(
  d: MaestroToolDeps,
  opts: MaestroToolOptions,
): AgentToolDefinition[] {
  const { confirmBeforeSend, webSearchEnabled } = opts;
  return [
    ...createUserTools(d.users, d.workspaces),
    ...createMediaTools(d.unsplash, d.pexels),
    ...(webSearchEnabled ? createWebTools(d.tavily) : []),
    ...createDiscordTools(d.discord, d.inbox, { confirmBeforeSend }),
    ...createSlackTools(d.slack, d.inbox, { confirmBeforeSend }),
    ...createTelegramTools(d.inbox, { confirmBeforeSend }),
    ...createWhatsAppTools(d.inbox, { confirmBeforeSend }),
    ...createPostTools(d.posts, { confirmBeforeSend }),
    ...createChannelTools(d.channels),
    ...createCampaignTools(d.campaigns),
    ...createLibraryTools(d.library, { confirmBeforeSend }),
    ...createInboxTools(d.conversations),
    ...createPlannerTools({
      posts: d.posts,
      scheduledMessages: d.scheduledMessages,
      drips: d.drips,
      workspaces: d.workspaces,
      campaigns: d.campaigns,
    }),
    ...createInteractionTools(),
    // Only where there is a page to navigate: the bridges are plain chat.
    ...(opts.canNavigate ? createNavigateTools() : []),
  ];
}
