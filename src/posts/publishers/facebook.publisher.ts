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
    const { content, mediaItems, accessToken, platformAccountId, metadata } = options;

    this.validate(options);

    const postType = (metadata?.postType as string | undefined) ?? 'post';
    let result: { postId: string };

    if (postType === 'reel') {
      // Reels require a vertical video. If no media or first is not a video, fail clearly.
      if (mediaItems.length === 0 || mediaItems[0].type !== 'video') {
        throw new Error('Facebook Reels require a vertical video file');
      }
      result = await this.facebookService.postReelToPage(
        platformAccountId,
        accessToken,
        mediaItems[0].url,
        content,
      );
    } else if (postType === 'story') {
      // Stories require exactly one image OR one video.
      if (mediaItems.length === 0) {
        throw new Error('Facebook Stories require 1 photo or video');
      }
      const item = mediaItems[0];
      if (item.type === 'image') {
        result = await this.facebookService.postPhotoStoryToPage(
          platformAccountId,
          accessToken,
          item.url,
        );
      } else if (item.type === 'video') {
        result = await this.facebookService.postVideoStoryToPage(
          platformAccountId,
          accessToken,
          item.url,
        );
      } else {
        throw new Error(`Facebook Stories don't support media type: ${item.type}`);
      }
    } else if (mediaItems.length > 0 && mediaItems[0].type === 'image') {
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

    const publishResult: PublishResult = {
      platformPostId: result.postId,
      platformPostUrl: `https://facebook.com/${result.postId}`,
    };

    // Soft action: post first comment if provided. Failure here is logged
    // and surfaced as a warning — the main post stays "published".
    const firstComment = typeof metadata?.firstComment === 'string'
      ? metadata.firstComment.trim()
      : '';
    if (firstComment.length > 0) {
      try {
        const comment = await this.facebookService.postComment(
          platformAccountId,
          accessToken,
          result.postId,
          firstComment,
        );
        this.logger.log(
          `First comment posted on Facebook post ${result.postId}: ${comment.commentId}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentId: comment.commentId,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on Facebook post ${result.postId}: ${reason}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentWarning: reason,
        };
      }
    }

    return publishResult;
  }
}
