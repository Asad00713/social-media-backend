import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

/**
 * Tools for media actions: download, save to library, etc.
 * These tools emit frontend actions rather than fetching data.
 */
export function createMediaActionTools(): ChatbotTool[] {
  return [
    {
      name: 'download_media',
      description:
        'Download an image or video for the user. Use this when the user asks to download a specific image or video from previously returned media. Pass the exact URL from the Previously Returned Media list.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The exact media URL to download (from Previously Returned Media list)',
          },
          filename: {
            type: 'string',
            description:
              'Suggested filename for the download (e.g. "sunset-photo.jpg", "forest-video.mp4")',
          },
        },
        required: ['url'],
      },
      execute: async (
        params: Record<string, any>,
        _context: ToolContext,
      ): Promise<ToolResult> => {
        const url = params.url;
        if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
          return {
            success: false,
            error: 'Invalid media URL provided',
          };
        }

        // Derive a usable filename from the URL if none provided
        const fallbackName =
          url.split('/').pop()?.split('?')[0] || 'download';

        return {
          success: true,
          data: {
            action: 'download',
            url,
            filename: params.filename || fallbackName,
          },
        };
      },
    },
  ];
}
