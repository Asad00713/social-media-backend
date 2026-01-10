import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class FacebookPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'facebook';

  constructor(private readonly facebookService: FacebookService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems } = options;

    // Facebook allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('Facebook post must have content or media');
    }

    // Check character limit (Facebook allows up to 63,206 chars)
    if (content && content.length > 63206) {
      throw new Error('Facebook content exceeds character limit');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId } = options;

    this.validate(options);

    let result: { postId: string };

    if (mediaItems.length > 0 && mediaItems[0].type === 'image') {
      result = await this.facebookService.postPhotoToPage(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        content,
      );
    } else {
      result = await this.facebookService.postToPage(
        platformAccountId,
        accessToken,
        content,
      );
    }

    this.logger.log(`Published to Facebook page: ${result.postId}`);

    return {
      platformPostId: result.postId,
      platformPostUrl: `https://facebook.com/${result.postId}`,
    };
  }
}
