import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { ThreadsService } from '../../channels/services/threads.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class ThreadsPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'threads';

  constructor(private readonly threadsService: ThreadsService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems } = options;

    // Threads allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('Threads post must have content or media');
    }

    // Check character limit
    if (content && content.length > 500) {
      throw new Error(`Threads content exceeds 500 character limit (${content.length} chars)`);
    }

    // Check media limit
    if (mediaItems.length > 10) {
      throw new Error('Threads allows maximum 10 media items per carousel');
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
    const replyToId = metadata?.replyToId;

    if (mediaItems.length === 0) {
      // Text-only post
      result = await this.threadsService.createTextThread(
        accessToken,
        platformAccountId,
        content,
        replyToId,
      );
    } else if (mediaItems.length === 1) {
      if (mediaItems[0].type === 'video') {
        result = await this.threadsService.createVideoThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
        );
      } else {
        result = await this.threadsService.createImageThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
        );
      }
    } else {
      // Carousel post
      result = await this.threadsService.createCarouselThread(
        accessToken,
        platformAccountId,
        mediaItems.map((m) => ({
          type: m.type === 'video' ? 'VIDEO' as const : 'IMAGE' as const,
          url: m.url,
        })),
        content,
        replyToId,
      );
    }

    this.logger.log(`Published to Threads: ${result.postId}`);

    return {
      platformPostId: result.postId,
    };
  }
}
