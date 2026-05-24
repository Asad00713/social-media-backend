import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { TikTokService } from '../../channels/services/tiktok.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class TikTokPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'tiktok';

  constructor(private readonly tiktokService: TikTokService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { mediaItems, metadata } = options;
    const postType = (metadata?.postType as string | undefined) ?? 'video';

    // TikTok requires media (video or images)
    if (mediaItems.length === 0) {
      throw new Error('TikTok posts require media');
    }

    if (postType === 'photo') {
      // Photo mode: 1-35 images
      if (mediaItems.length > 35) {
        throw new Error('TikTok photo posts allow at most 35 images');
      }
      if (!mediaItems.every((m) => m.type === 'image')) {
        throw new Error('TikTok photo posts only accept image media');
      }
    } else if (mediaItems[0].type !== 'video') {
      throw new Error('TikTok only supports video content');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    // TikTok supports videos (single) or images (carousel photo mode)
    if (mediaItems.length === 0) return false;
    const allVideos = mediaItems.every((m) => m.type === 'video');
    const allImages = mediaItems.every((m) => m.type === 'image');
    return allVideos || allImages;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, metadata } = options;

    this.validate(options);

    const postType = (metadata?.postType as string | undefined) ?? 'video';

    // Get privacy level from metadata, default to SELF_ONLY for safety
    const privacyLevel = metadata?.privacyLevel || 'SELF_ONLY';

    // Photo carousel flow (PULL_FROM_URL)
    if (postType === 'photo') {
      const imageUrls = mediaItems.map((m) => m.url);
      this.logger.log(
        `Publishing TikTok photo carousel: ${imageUrls.length} image(s)`,
      );

      const photoResult = await this.tiktokService.postPhotoFromUrl(
        accessToken,
        imageUrls,
        content || '',
        metadata?.title || '',
        privacyLevel,
      );

      this.logger.log(
        `TikTok photo publish initiated: ${photoResult.publishId}`,
      );

      return {
        platformPostId: photoResult.publishId,
        platformPostUrl: undefined,
        metadata: {
          publishId: photoResult.publishId,
          status: 'processing',
          note: 'Photo carousel is being processed by TikTok. Use the publish status endpoint to check completion.',
        },
      };
    }

    // Video flow (existing)
    const videoItem = mediaItems[0];
    const title = content || metadata?.title || '';
    const useDirectUpload = metadata?.useDirectUpload ?? true; // Default to direct upload for reliability

    this.logger.log(`Publishing TikTok video: ${videoItem.url}`);

    let result: { publishId: string };

    if (useDirectUpload) {
      // Download and upload directly to TikTok (more reliable)
      result = await this.tiktokService.uploadVideoFromUrl(
        accessToken,
        videoItem.url,
        {
          title,
          privacyLevel,
          disableDuet: metadata?.disableDuet ?? false,
          disableStitch: metadata?.disableStitch ?? false,
          disableComment: metadata?.disableComment ?? false,
          videoCoverTimestampMs: metadata?.videoCoverTimestampMs ?? 1000,
        },
      );
    } else {
      // Let TikTok pull from URL (faster but URL must be publicly accessible)
      result = await this.tiktokService.postVideoFromUrl(
        accessToken,
        videoItem.url,
        {
          title,
          privacyLevel,
          disableDuet: metadata?.disableDuet ?? false,
          disableStitch: metadata?.disableStitch ?? false,
          disableComment: metadata?.disableComment ?? false,
          videoCoverTimestampMs: metadata?.videoCoverTimestampMs ?? 1000,
        },
      );
    }

    this.logger.log(`TikTok video publish initiated: ${result.publishId}`);

    // Note: TikTok video publishing is asynchronous
    // The publishId can be used to check the status later
    return {
      platformPostId: result.publishId,
      // TikTok doesn't immediately return the video URL
      // The video ID will be available once publishing is complete
      platformPostUrl: undefined,
      metadata: {
        publishId: result.publishId,
        status: 'processing',
        note: 'Use the publish status endpoint to check when the video is ready',
      },
    };
  }
}
