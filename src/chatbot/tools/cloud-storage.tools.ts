import type { ChannelService } from '../../channels/services/channel.service';
import type { GoogleDriveService } from '../../channels/services/google-drive.service';
import type { OneDriveService } from '../../channels/services/onedrive.service';
import type { DropboxService } from '../../channels/services/dropbox.service';
import type { GooglePhotosService } from '../../channels/services/google-photos.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

const PLATFORM_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  google_photos: 'Google Photos',
};

/**
 * Finds the user's connected channel for a platform and returns the access token.
 * Returns a helpful error message if not connected.
 */
async function getIntegrationToken(
  channelService: ChannelService,
  context: ToolContext,
  platform: string,
): Promise<{ token: string; channelId: number } | { error: string }> {
  try {
    const channels = await channelService.getWorkspaceChannels(
      context.workspaceId,
      {
        platform: platform as any,
        connectionStatus: 'connected',
        isActive: true,
      },
    );

    if (!channels.length) {
      const label = PLATFORM_LABELS[platform] || platform;
      return {
        error: `${label} is not connected to this workspace. To connect it, go to **[Channels → Connect](/channels/connect)** and link your ${label} account. Once connected, I'll be able to search your files there!`,
      };
    }

    const channel = channels[0];
    const token = await channelService.getAccessToken(
      channel.id,
      context.workspaceId,
    );
    return { token, channelId: channel.id };
  } catch (error) {
    const label = PLATFORM_LABELS[platform] || platform;
    return {
      error: `Failed to access ${label}: ${error instanceof Error ? error.message : 'Unknown error'}. Your token may have expired — try reconnecting at [Channels](/channels).`,
    };
  }
}

export function createCloudStorageTools(
  channelService: ChannelService,
  googleDriveService: GoogleDriveService,
  oneDriveService: OneDriveService,
  dropboxService: DropboxService,
  googlePhotosService: GooglePhotosService,
): ChatbotTool[] {
  return [
    // ===== GOOGLE DRIVE =====
    {
      name: 'search_google_drive',
      description:
        "Search for files (images, videos, documents) in the user's connected Google Drive. Use this when the user mentions a file in their Drive or wants to find media from Google Drive for a post. Requires the user to have Google Drive connected.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query — matches file names (e.g. "beach sunset", "logo", "product photo")',
          },
          mediaOnly: {
            type: 'boolean',
            description:
              'If true, only return images and videos (default: true)',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default: 10, max: 20)',
          },
        },
        required: ['query'],
      },
      execute: async (
        params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        const auth = await getIntegrationToken(
          channelService,
          context,
          'google_drive',
        );
        if ('error' in auth) return { success: false, error: auth.error };

        try {
          const maxResults = Math.min(params.maxResults || 10, 20);
          const mediaOnly = params.mediaOnly !== false;

          const result = mediaOnly
            ? await googleDriveService.listMedia(auth.token, {
                query: params.query,
                pageSize: maxResults,
              })
            : await googleDriveService.listFiles(auth.token, {
                query: params.query,
                pageSize: maxResults,
              });

          return {
            success: true,
            data: {
              files: result.files.map((f: any) => ({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                thumbnailLink: f.thumbnailLink,
                webViewLink: f.webViewLink,
                webContentLink: f.webContentLink,
                size: f.size,
                modifiedTime: f.modifiedTime,
              })),
              total: result.files.length,
              source: 'Google Drive',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Google Drive search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },

    // ===== ONEDRIVE =====
    {
      name: 'search_onedrive',
      description:
        "Search for files in the user's connected OneDrive. Use this when the user mentions a file in OneDrive or wants to find media from their Microsoft account. Requires OneDrive to be connected.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query — matches file names (e.g. "presentation", "team photo")',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default: 10, max: 20)',
          },
        },
        required: ['query'],
      },
      execute: async (
        params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        const auth = await getIntegrationToken(
          channelService,
          context,
          'onedrive',
        );
        if ('error' in auth) return { success: false, error: auth.error };

        try {
          const maxResults = Math.min(params.maxResults || 10, 20);
          const result = await oneDriveService.searchFiles(
            auth.token,
            params.query,
            { pageSize: maxResults },
          );

          return {
            success: true,
            data: {
              files: result.items.map((f: any) => ({
                id: f.id,
                name: f.name,
                size: f.size,
                mimeType: f.file?.mimeType,
                webUrl: f.webUrl,
                downloadUrl: f['@microsoft.graph.downloadUrl'],
                thumbnails: f.thumbnails?.[0],
                lastModified: f.lastModifiedDateTime,
                image: f.image,
                video: f.video,
              })),
              total: result.items.length,
              source: 'OneDrive',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `OneDrive search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },

    // ===== DROPBOX =====
    {
      name: 'search_dropbox',
      description:
        "Search for files in the user's connected Dropbox. Use this when the user mentions a file in Dropbox or wants to find media stored there. Requires Dropbox to be connected.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query — full text search across file names (e.g. "logo design", "promo video")',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default: 10, max: 20)',
          },
          fileExtensions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter by file extensions (e.g. ["jpg", "png", "mp4"])',
          },
        },
        required: ['query'],
      },
      execute: async (
        params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        const auth = await getIntegrationToken(
          channelService,
          context,
          'dropbox',
        );
        if ('error' in auth) return { success: false, error: auth.error };

        try {
          const maxResults = Math.min(params.maxResults || 10, 20);
          const result = await dropboxService.searchFiles(
            auth.token,
            params.query,
            {
              maxResults,
              fileExtensions: params.fileExtensions,
            },
          );

          // Get temporary download links for each file in parallel
          const files = await Promise.all(
            result.matches.map(async (match: any) => {
              const f = match.metadata?.metadata || match.metadata || match;
              let downloadUrl: string | undefined;
              try {
                if (f.is_downloadable && f.path_display) {
                  downloadUrl = await dropboxService.getTemporaryLink(
                    auth.token,
                    f.path_display,
                  );
                }
              } catch {
                // Temporary link failed — leave downloadUrl undefined
              }
              return {
                id: f.id,
                name: f.name,
                path: f.path_display,
                downloadUrl,
                size: f.size,
                isDownloadable: f.is_downloadable,
                lastModified: f.server_modified,
                mediaInfo: f.media_info?.metadata,
              };
            }),
          );

          return {
            success: true,
            data: {
              files,
              total: result.matches.length,
              hasMore: result.has_more,
              source: 'Dropbox',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Dropbox search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },

    // ===== GOOGLE PHOTOS =====
    {
      name: 'search_google_photos',
      description:
        "Browse photos and videos from the user's connected Google Photos library. Note: Google Photos does not support text search — it only supports filtering by media type (photo/video) and listing recent items. Use this when the user wants to browse their Google Photos. Requires Google Photos to be connected.",
      parameters: {
        type: 'object',
        properties: {
          mediaType: {
            type: 'string',
            description:
              'Filter by media type. Allowed values: "photo", "video", "all" (default: "all").',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default: 15, max: 25)',
          },
        },
        required: [],
      },
      execute: async (
        params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        const auth = await getIntegrationToken(
          channelService,
          context,
          'google_photos',
        );
        if ('error' in auth) return { success: false, error: auth.error };

        try {
          const maxResults = Math.min(params.maxResults || 15, 25);
          const validMediaTypes = ['photo', 'video', 'all'];
          const mediaType = validMediaTypes.includes(params.mediaType)
            ? params.mediaType
            : 'all';

          const filterMap: Record<string, 'ALL_MEDIA' | 'PHOTO' | 'VIDEO'> = {
            all: 'ALL_MEDIA',
            photo: 'PHOTO',
            video: 'VIDEO',
          };

          const result = await googlePhotosService.searchMediaItems(
            auth.token,
            {
              pageSize: maxResults,
              filters: { mediaTypeFilter: filterMap[mediaType] || 'ALL_MEDIA' },
            },
          );

          return {
            success: true,
            data: {
              items: (result.mediaItems || []).map((item: any) => ({
                id: item.id,
                filename: item.filename,
                mimeType: item.mimeType,
                baseUrl: item.baseUrl,
                productUrl: item.productUrl,
                width: item.mediaMetadata?.width,
                height: item.mediaMetadata?.height,
                creationTime: item.mediaMetadata?.creationTime,
              })),
              total: (result.mediaItems || []).length,
              source: 'Google Photos',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Google Photos browsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
