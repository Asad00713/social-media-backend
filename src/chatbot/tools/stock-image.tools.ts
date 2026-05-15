import type { UnsplashService } from '../../channels/services/unsplash.service';
import type { PexelsService } from '../../pexels/pexels.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

/**
 * Helper: check if a string is a plausible image/video URL.
 */
function isValidUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://');
}

export function createStockImageTools(
  unsplashService: UnsplashService,
  pexelsService: PexelsService,
): ChatbotTool[] {
  return [
    {
      name: 'search_unsplash',
      description:
        'Search Unsplash for high-quality stock photos. Returns image URLs, photographer info, and dimensions. Use this when the user needs images for posts or wants stock photos. If this tool fails, immediately try search_pexels with the same query instead.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g. "summer fashion", "beach sunset", "coffee shop")',
          },
          perPage: {
            type: 'number',
            description:
              'Number of images to return. IMPORTANT: Match this to the user\'s request — if they ask for "an image" set perPage=1, "3 images" set perPage=3. Default: 3, max: 30.',
          },
          orientation: {
            type: 'string',
            description:
              'Filter by image orientation. Allowed values: "landscape" (for YouTube/Twitter/Facebook/LinkedIn), "portrait" (for TikTok/Instagram Stories/Reels/Pinterest), "squarish" (for Instagram feed/Threads). If unsure, omit this parameter.',
          },
          page: {
            type: 'number',
            description:
              'Page number for pagination. Use page=1 for first request. When the user asks for "more" images, increment this (page=2, page=3, etc.) to get fresh results.',
          },
        },
        required: ['query'],
      },
      execute: async (params: Record<string, any>, _context: ToolContext): Promise<ToolResult> => {
        try {
          const perPage = Math.min(params.perPage || 3, 30);
          const page = Math.max(params.page || 1, 1);
          // Normalize orientation — LLMs sometimes pass invalid values
          const validOrientations = ['landscape', 'portrait', 'squarish'];
          const orientation = validOrientations.includes(params.orientation)
            ? params.orientation
            : undefined;
          const result = await unsplashService.searchPhotos(
            params.query,
            page,
            perPage,
            orientation,
          );

          const images = result.results
            .map((photo: any) => ({
              id: photo.id,
              description: photo.description || photo.altDescription,
              width: photo.width,
              height: photo.height,
              urls: {
                regular: photo.urls?.regular,
                small: photo.urls?.small,
                thumb: photo.urls?.thumb,
              },
              photographer: photo.user?.name,
              downloadLocation: photo.links?.downloadLocation,
            }))
            .filter(
              (img: any) =>
                isValidUrl(img.urls?.regular) || isValidUrl(img.urls?.small),
            );

          return {
            success: true,
            data: { total: result.total, images },
          };
        } catch (error) {
          return {
            success: false,
            error: `Unsplash search failed: ${error instanceof Error ? error.message : 'Unknown error'}. Try search_pexels instead.`,
          };
        }
      },
    },
    {
      name: 'search_pexels',
      description:
        'Search Pexels for free stock photos and videos. Returns image/video URLs, photographer info, and dimensions. Use this as a primary or fallback image source. If search_unsplash fails, use this tool instead.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g. "nature", "business meeting", "food photography")',
          },
          perPage: {
            type: 'number',
            description:
              'Number of results to return. IMPORTANT: Match this to the user\'s request — if they ask for "an image" set perPage=1, "3 images" set perPage=3. Default: 3, max: 30.',
          },
          orientation: {
            type: 'string',
            description:
              'Filter by orientation. Allowed values: "landscape" (for YouTube/Twitter/Facebook/LinkedIn), "portrait" (for TikTok/Instagram Stories/Reels/Pinterest), "square" (for Instagram feed). If unsure, omit this parameter.',
          },
          type: {
            type: 'string',
            description: 'Search for photos or videos. Allowed values: "photo" (default), "video".',
          },
          page: {
            type: 'number',
            description:
              'Page number for pagination. Use page=1 for first request. When the user asks for "more" images/videos, increment this (page=2, page=3, etc.) to get fresh results.',
          },
        },
        required: ['query'],
      },
      execute: async (params: Record<string, any>, _context: ToolContext): Promise<ToolResult> => {
        try {
          const perPage = Math.min(params.perPage || 3, 30);
          const page = Math.max(params.page || 1, 1);
          const searchType = ['photo', 'video'].includes(params.type) ? params.type : 'photo';
          // Normalize orientation — LLMs sometimes pass invalid values
          const validOrientations = ['landscape', 'portrait', 'square'];
          const orientation = validOrientations.includes(params.orientation)
            ? params.orientation
            : undefined;

          if (searchType === 'video') {
            const result = await pexelsService.searchVideos({
              query: params.query,
              orientation,
              perPage,
              page,
            });

            const videos = result.items
              .map((video: any) => ({
                id: video.id,
                width: video.width,
                height: video.height,
                duration: video.duration,
                image: video.image,
                url: video.url,
                videoFiles: video.videoFiles
                  ?.filter((f: any) => isValidUrl(f.link))
                  .slice(0, 3)
                  .map((f: any) => ({
                    quality: f.quality,
                    width: f.width,
                    height: f.height,
                    link: f.link,
                  })),
                photographer: video.user?.name,
              }))
              .filter(
                (v: any) =>
                  isValidUrl(v.image) || v.videoFiles?.length > 0,
              );

            return {
              success: true,
              data: { total: result.totalResults, videos },
            };
          }

          const result = await pexelsService.searchPhotos({
            query: params.query,
            orientation,
            perPage,
            page,
          });

          const images = result.items
            .map((photo: any) => ({
              id: photo.id,
              width: photo.width,
              height: photo.height,
              alt: photo.alt,
              src: {
                original: photo.src?.original,
                large: photo.src?.large,
                medium: photo.src?.medium,
                small: photo.src?.small,
              },
              photographer: photo.photographer,
            }))
            .filter(
              (img: any) =>
                isValidUrl(img.src?.large) || isValidUrl(img.src?.medium),
            );

          return {
            success: true,
            data: { total: result.totalResults, images },
          };
        } catch (error) {
          return {
            success: false,
            error: `Pexels search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
