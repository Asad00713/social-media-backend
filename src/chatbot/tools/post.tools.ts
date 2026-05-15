import type { PostService } from '../../posts/services/post.service';
import type { ChannelService } from '../../channels/services/channel.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

/**
 * Normalize a mediaItems parameter — LLMs may pass strings instead of objects,
 * omit the `type` field, or use other unexpected shapes.
 */
function normalizeMediaItems(raw: any): Array<{ url: string; type: string; thumbnailUrl?: string; altText?: string }> {
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      // If the LLM passed a bare URL string, wrap it
      if (typeof item === 'string') {
        return { url: item, type: 'image' };
      }
      // If it's an object, ensure required fields
      if (item && typeof item === 'object') {
        return {
          url: item.url || '',
          type: item.type || 'image',
          ...(item.thumbnailUrl && { thumbnailUrl: item.thumbnailUrl }),
          ...(item.altText && { altText: item.altText }),
        };
      }
      return null;
    })
    .filter((item: any) => item && item.url);
}

export function createPostTools(
  postService: PostService,
  channelService: ChannelService,
): ChatbotTool[] {
  return [
    {
      name: 'list_posts',
      description:
        'List posts in the current workspace with optional filtering by status or channel. Returns post content, status, target channels, and scheduling info. Use this when the user asks to see their posts, drafts, or published content.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status: "draft", "scheduled", "publishing", "published", "failed", "partially_published"',
          },
          channelId: {
            type: 'string',
            description: 'Filter by target channel ID',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of posts to return (default: 10, max: 25)',
          },
        },
        required: [],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const limit = Math.min(params.limit || 10, 25);
          const result = await postService.getWorkspacePosts(context.workspaceId, {
            status: params.status,
            channelId: params.channelId,
            limit,
          });
          return {
            success: true,
            data: {
              posts: result.posts.map((p) => ({
                id: p.id,
                content: p.content,
                status: p.status,
                targets: p.targets,
                scheduledAt: p.scheduledAt,
                publishedAt: p.publishedAt,
                createdAt: p.createdAt,
                mediaItems: p.mediaItems,
              })),
              total: result.total,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to list posts: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'get_post',
      description:
        'Get full details of a specific post by its ID. Returns content, status, media, target channels, and scheduling info.',
      parameters: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: 'The UUID of the post',
          },
        },
        required: ['postId'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const post = await postService.getPost(params.postId, context.workspaceId);
          return {
            success: true,
            data: {
              id: post.id,
              content: post.content,
              status: post.status,
              targets: post.targets,
              scheduledAt: post.scheduledAt,
              publishedAt: post.publishedAt,
              createdAt: post.createdAt,
              updatedAt: post.updatedAt,
              mediaItems: post.mediaItems,
              platformContent: post.platformContent,
              metadata: post.metadata,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get post: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'preview_post',
      description:
        'Show a visual preview of a post BEFORE creating it. Call this FIRST so the user can review the content, media, and target channels. Does NOT create the post — only generates a preview card. After the user approves (or requests changes), call create_post to actually create it.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The text content / caption of the post',
          },
          targetChannelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of channel IDs to publish to (use list_channels to find IDs)',
          },
          mediaItems: {
            type: 'array',
            description: 'Media to attach. Pass an array of objects like [{url: "https://...", type: "image"}] or an array of URL strings. Use URLs from previous search_unsplash, search_pexels, or search_media_library results.',
          },
          scheduledAt: {
            type: 'string',
            description: 'ISO 8601 date-time if scheduling (e.g. "2026-03-15T14:00:00Z"). Omit for draft.',
          },
        },
        required: ['content', 'targetChannelIds'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const channelDetails = await Promise.all(
            (params.targetChannelIds || []).map(async (channelId: string) => {
              try {
                const ch = await channelService.getChannelById(
                  Number(channelId),
                  context.workspaceId,
                );
                return {
                  channelId,
                  platform: ch.platform,
                  channelName: ch.accountName || ch.username || ch.platform,
                  channelAvatar: ch.profilePictureUrl || null,
                  channelUsername: ch.username || null,
                };
              } catch {
                return {
                  channelId,
                  platform: 'unknown',
                  channelName: 'Unknown Channel',
                  channelAvatar: null,
                  channelUsername: null,
                };
              }
            }),
          );

          const mediaItems = normalizeMediaItems(params.mediaItems);

          return {
            success: true,
            data: {
              id: 'preview',
              content: params.content,
              status: params.scheduledAt ? 'scheduled' : 'draft',
              scheduledAt: params.scheduledAt || null,
              mediaItems,
              targets: channelDetails,
              metadata: {},
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to generate preview: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'create_post',
      description:
        'Create a new post (as draft or scheduled). IMPORTANT: Always call preview_post FIRST so the user can review. Only call this after the user explicitly confirms the preview. Requires content and at least one target channel ID.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The text content / caption of the post',
          },
          targetChannelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of channel IDs to publish to (use list_channels to find IDs)',
          },
          mediaItems: {
            type: 'array',
            description: 'Media to attach. Pass an array of objects like [{url: "https://...", type: "image"}] or an array of URL strings. Use URLs from previous search_unsplash, search_pexels, or search_media_library results.',
          },
          scheduledAt: {
            type: 'string',
            description: 'ISO 8601 date-time to schedule the post (e.g. "2026-03-15T14:00:00Z"). If omitted, creates as draft.',
          },
        },
        required: ['content', 'targetChannelIds'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const dto: any = {
            content: params.content,
            targetChannelIds: params.targetChannelIds,
          };
          const normalized = normalizeMediaItems(params.mediaItems);
          if (normalized.length > 0) {
            dto.mediaItems = normalized;
          }
          if (params.scheduledAt) {
            dto.scheduledAt = new Date(params.scheduledAt);
          }
          const post = await postService.createPost(context.workspaceId, context.userId, dto);

          // Look up channel details for each target to enrich the preview
          const targets = post.targets as Array<{
            channelId: string;
            platform: string;
            status: string;
            contentOverride?: any;
          }>;
          const channelDetails = await Promise.all(
            targets.map(async (t) => {
              try {
                const ch = await channelService.getChannelById(
                  Number(t.channelId),
                  context.workspaceId,
                );
                return {
                  channelId: t.channelId,
                  platform: t.platform,
                  channelName: ch.accountName || ch.username || t.platform,
                  channelAvatar: ch.profilePictureUrl || null,
                  channelUsername: ch.username || null,
                  contentOverride: t.contentOverride || null,
                };
              } catch {
                return {
                  channelId: t.channelId,
                  platform: t.platform,
                  channelName: t.platform,
                  channelAvatar: null,
                  channelUsername: null,
                  contentOverride: t.contentOverride || null,
                };
              }
            }),
          );

          return {
            success: true,
            data: {
              id: post.id,
              content: post.content,
              status: post.status,
              scheduledAt: post.scheduledAt,
              createdAt: post.createdAt,
              mediaItems: post.mediaItems || [],
              targets: channelDetails,
              metadata: post.metadata || {},
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to create post: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'update_post',
      description:
        'Update an existing draft or scheduled post. Can change content, media, target channels, or schedule time. Cannot update published posts.',
      parameters: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: 'The UUID of the post to update',
          },
          content: {
            type: 'string',
            description: 'New text content for the post',
          },
          mediaItems: {
            type: 'array',
            description: 'New media items to replace existing ones. Pass an array of objects like [{url: "https://...", type: "image"}] or an array of URL strings. Use URLs from search_unsplash, search_pexels, or search_media_library.',
          },
          targetChannelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'New array of target channel IDs',
          },
          scheduledAt: {
            type: 'string',
            description: 'New scheduled date-time (ISO 8601) or null to unschedule',
          },
        },
        required: ['postId'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const dto: any = {};
          if (params.content !== undefined) dto.content = params.content;
          if (params.mediaItems !== undefined) {
            dto.mediaItems = normalizeMediaItems(params.mediaItems);
          }
          if (params.targetChannelIds !== undefined) dto.targetChannelIds = params.targetChannelIds;
          if (params.scheduledAt !== undefined) {
            dto.scheduledAt = params.scheduledAt ? new Date(params.scheduledAt) : null;
          }
          const post = await postService.updatePost(params.postId, context.workspaceId, context.userId, dto);
          return {
            success: true,
            data: {
              id: post.id,
              content: post.content,
              status: post.status,
              targets: post.targets,
              scheduledAt: post.scheduledAt,
              updatedAt: post.updatedAt,
              mediaItems: post.mediaItems || [],
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to update post: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'delete_post',
      description:
        'Delete a draft or scheduled post. Cannot delete published posts. This action is irreversible. Requires user confirmation — the tool will return a confirmation prompt on first call. Only call again with confirmed=true after the user explicitly agrees.',
      requiresConfirmation: true,
      confirmationMessage: (params) =>
        `Are you sure you want to delete post \`${params.postId}\`? This action cannot be undone.`,
      parameters: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: 'The UUID of the post to delete',
          },
          confirmed: {
            type: 'boolean',
            description: 'Set to true only after the user has explicitly confirmed deletion',
          },
        },
        required: ['postId'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          await postService.deletePost(params.postId, context.workspaceId, context.userId);
          return {
            success: true,
            data: { deleted: true, postId: params.postId },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to delete post: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'list_scheduled_posts',
      description:
        'List posts scheduled within a specific date range. Useful for checking what\'s coming up on the calendar. Use this when the user asks about upcoming or scheduled posts.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: {
            type: 'string',
            description: 'Start date in ISO 8601 format (e.g. "2026-02-12T00:00:00Z")',
          },
          toDate: {
            type: 'string',
            description: 'End date in ISO 8601 format (e.g. "2026-02-19T23:59:59Z")',
          },
        },
        required: ['fromDate', 'toDate'],
      },
      execute: async (params: Record<string, any>, context: ToolContext): Promise<ToolResult> => {
        try {
          const posts = await postService.getScheduledPosts(
            context.workspaceId,
            new Date(params.fromDate),
            new Date(params.toDate),
          );
          return {
            success: true,
            data: {
              posts: posts.map((p) => ({
                id: p.id,
                content: p.content,
                status: p.status,
                targets: p.targets,
                scheduledAt: p.scheduledAt,
                createdAt: p.createdAt,
              })),
              total: posts.length,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to list scheduled posts: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
