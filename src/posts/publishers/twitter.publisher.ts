import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  TwitterService,
  TwitterOAuth1Credentials,
} from '../../channels/services/twitter.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class TwitterPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'twitter';

  constructor(private readonly twitterService: TwitterService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    // Twitter allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('Twitter post must have content or media');
    }

    // Check character limit
    if (content && content.length > 280) {
      throw new Error(`Twitter content exceeds 280 character limit (${content.length} chars)`);
    }

    // Check media limit
    if (mediaItems.length > 4) {
      throw new Error('Twitter allows maximum 4 media items per post');
    }

    // Poll validation
    const poll = metadata?.poll;
    if (poll) {
      if (mediaItems.length > 0) {
        throw new Error('Twitter polls cannot be combined with media');
      }
      if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 4) {
        throw new Error('Twitter polls must have 2-4 options');
      }
      for (const option of poll.options) {
        if (typeof option !== 'string' || option.length < 1 || option.length > 25) {
          throw new Error('Each poll option must be 1-25 characters');
        }
      }
      const duration = poll.durationMinutes;
      if (typeof duration !== 'number' || duration < 5 || duration > 10080) {
        throw new Error('Poll duration must be between 5 and 10080 minutes (7 days)');
      }
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'gif'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, channelMetadata } = options;

    this.validate(options);

    // Get OAuth 1.0a credentials from channel metadata (if available)
    const oauth1Credentials = this.getOAuth1Credentials(channelMetadata);

    // Upload media if present
    let mediaIds: string[] | undefined;
    if (mediaItems && mediaItems.length > 0) {
      mediaIds = await this.uploadMediaItems(accessToken, mediaItems, oauth1Credentials);
    }

    // Build poll options from metadata
    const pollData = options.metadata?.poll;
    const poll = pollData
      ? { options: pollData.options as string[], durationMinutes: pollData.durationMinutes as number }
      : undefined;

    // Create tweet with optional media and/or poll
    const result = await this.twitterService.createTweet(accessToken, content, {
      mediaIds,
      poll,
    });

    this.logger.log(`Published tweet: ${result.id}`);

    return {
      platformPostId: result.id,
      platformPostUrl: `https://twitter.com/i/web/status/${result.id}`,
    };
  }

  /**
   * Extract OAuth 1.0a credentials from channel metadata
   */
  private getOAuth1Credentials(
    channelMetadata: Record<string, any>,
  ): TwitterOAuth1Credentials | undefined {
    if (channelMetadata?.oauthToken && channelMetadata?.oauthTokenSecret) {
      return {
        oauthToken: channelMetadata.oauthToken,
        oauthTokenSecret: channelMetadata.oauthTokenSecret,
      };
    }
    return undefined;
  }

  /**
   * Download and upload media items to Twitter
   */
  private async uploadMediaItems(
    accessToken: string,
    mediaItems: MediaItem[],
    oauth1Credentials?: TwitterOAuth1Credentials,
  ): Promise<string[]> {
    const mediaIds: string[] = [];

    for (const item of mediaItems) {
      try {
        // Download the media from URL
        const response = await fetch(item.url);
        if (!response.ok) {
          throw new Error(`Failed to download media from ${item.url}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Determine media type
        const mediaType = this.getMediaType(item);

        // Upload to Twitter with OAuth 1.0a if available
        const mediaId = await this.twitterService.uploadMedia(
          accessToken,
          buffer,
          mediaType,
          oauth1Credentials,
        );

        mediaIds.push(mediaId);
        this.logger.log(`Uploaded media to Twitter: ${mediaId}`);
      } catch (error) {
        this.logger.error(`Failed to upload media: ${error}`);
        throw new Error(`Failed to upload media: ${item.url}`);
      }
    }

    return mediaIds;
  }

  /**
   * Get the MIME type for Twitter upload
   */
  private getMediaType(
    item: MediaItem,
  ): 'image/jpeg' | 'image/png' | 'image/gif' | 'video/mp4' {
    // Check URL extension or type
    const url = item.url.toLowerCase();

    if (item.type === 'gif' || url.includes('.gif')) {
      return 'image/gif';
    }

    if (item.type === 'video' || url.includes('.mp4')) {
      return 'video/mp4';
    }

    if (url.includes('.png')) {
      return 'image/png';
    }

    // Default to JPEG for images
    return 'image/jpeg';
  }
}
