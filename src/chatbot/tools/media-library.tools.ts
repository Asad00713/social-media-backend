import type { MediaItemService } from '../../media-library/services/media-item.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

export function createMediaLibraryTools(
  mediaItemService: MediaItemService,
): ChatbotTool[] {
  return [
    {
      name: 'search_media_library',
      description:
        "Search the workspace's internal media library for uploaded images, videos, templates, and other assets. Use this when the user wants to reuse existing media they've previously uploaded, or browse their saved assets.",
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Search by file name or description',
          },
          type: {
            type: 'string',
            description:
              'Filter by media type. Allowed values: "image", "video", "gif", "document".',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 15, max: 30)',
          },
        },
        required: [],
      },
      execute: async (
        params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const limit = Math.min(params.limit || 15, 30);
          const validTypes = ['image', 'video', 'gif', 'document'];
          const type = validTypes.includes(params.type)
            ? params.type
            : undefined;
          const result = await mediaItemService.findAll(context.workspaceId, {
            search: params.search,
            type,
            limit,
            isDeleted: false,
          });

          return {
            success: true,
            data: {
              items: result.items.map((item: any) => ({
                id: item.id,
                name: item.name,
                description: item.description,
                type: item.type,
                fileUrl: item.fileUrl,
                thumbnailUrl: item.thumbnailUrl,
                mimeType: item.mimeType,
                width: item.width,
                height: item.height,
                duration: item.duration,
                tags: item.tags,
                isStarred: item.isStarred,
                usageCount: item.usageCount,
                createdAt: item.createdAt,
              })),
              total: result.total,
              source: 'Media Library',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Media library search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
