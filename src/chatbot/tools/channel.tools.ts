import type { ChannelService } from '../../channels/services/channel.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

function sanitizeChannel(channel: any) {
  const { accessToken, refreshToken, tokenScope, tokenExpiresAt, ...safe } = channel;
  return safe;
}

export function createChannelTools(channelService: ChannelService): ChatbotTool[] {
  return [
    {
      name: 'list_channels',
      description:
        'List all connected social media channels for the current workspace. Returns channel names, platforms, connection status, and account details. Use this when the user asks about their connected accounts, channels, or platforms.',
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            description: 'Filter by platform (e.g. "instagram", "twitter", "facebook", "youtube", "tiktok", "linkedin", "pinterest", "threads", "bluesky", "mastodon")',
          },
          status: {
            type: 'string',
            description: 'Filter by connection status: "connected", "expired", "revoked", "error"',
          },
        },
        required: [],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const query: any = {};
          if (params.platform) query.platform = params.platform;
          if (params.status) query.connectionStatus = params.status;

          const channels = await channelService.getWorkspaceChannels(context.workspaceId, query);
          return {
            success: true,
            data: {
              channels: channels.map(sanitizeChannel),
              total: channels.length,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to list channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'get_channel_details',
      description:
        'Get detailed information about a specific connected channel by its ID. Returns platform, account name, username, capabilities, and status.',
      parameters: {
        type: 'object',
        properties: {
          channelId: {
            type: 'number',
            description: 'The numeric ID of the channel',
          },
        },
        required: ['channelId'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const channel = await channelService.getChannelById(params.channelId, context.workspaceId);
          return {
            success: true,
            data: sanitizeChannel(channel),
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get channel details: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
