import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { InstagramService } from '../../channels/services/instagram.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class InstagramPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'instagram';

  constructor(private readonly instagramService: InstagramService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems } = options;

    // Instagram requires at least one media item
    if (mediaItems.length === 0) {
      throw new Error('Instagram posts require at least one image or video');
    }

    // Check caption limit
    if (content && content.length > 2200) {
      throw new Error(`Instagram caption exceeds 2200 character limit (${content.length} chars)`);
    }

    // Check media limit for carousel
    if (mediaItems.length > 10) {
      throw new Error('Instagram allows maximum 10 media items per carousel');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'carousel'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, metadata } = options;

    this.validate(options);

    let result: { postId: string };

    if (mediaItems.length === 1) {
      if (mediaItems[0].type === 'video') {
        const isReel = metadata?.isReel || false;
        result = await this.instagramService.createVideoPost(
          platformAccountId,
          accessToken,
          mediaItems[0].url,
          content,
          isReel,
        );
      } else {
        result = await this.instagramService.createImagePost(
          platformAccountId,
          accessToken,
          mediaItems[0].url,
          content,
        );
      }
    } else {
      // Carousel post
      result = await this.instagramService.createCarouselPost(
        platformAccountId,
        accessToken,
        mediaItems.map((m) => ({
          type: m.type === 'video' ? 'VIDEO' as const : 'IMAGE' as const,
          url: m.url,
        })),
        content,
      );
    }

    this.logger.log(`Published to Instagram: ${result.postId}`);

    return {
      platformPostId: result.postId,
    };
  }
}
