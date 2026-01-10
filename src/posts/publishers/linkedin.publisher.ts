import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class LinkedInPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'linkedin';

  constructor(private readonly linkedinService: LinkedInService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems } = options;

    // LinkedIn allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('LinkedIn post must have content or media');
    }

    // Check character limit (LinkedIn allows up to 3000 chars)
    if (content && content.length > 3000) {
      throw new Error(`LinkedIn content exceeds 3000 character limit (${content.length} chars)`);
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, channelMetadata, metadata } = options;

    this.validate(options);

    const isOrganization = channelMetadata?.isOrganization || false;
    const visibility = metadata?.visibility || 'PUBLIC';

    let result: { postId: string };

    if (mediaItems.length > 0) {
      const mediaItem = mediaItems[0];

      if (mediaItem.type === 'image') {
        // Image post
        if (isOrganization) {
          result = await this.linkedinService.createOrganizationPostWithImage(
            accessToken,
            platformAccountId,
            content || '',
            mediaItem.url,
            metadata?.imageTitle,
          );
        } else {
          result = await this.linkedinService.createPostWithImage(
            accessToken,
            platformAccountId,
            content || '',
            mediaItem.url,
            metadata?.imageTitle,
            visibility,
          );
        }
      } else if (mediaItem.type === 'video') {
        // Video post
        if (isOrganization) {
          result = await this.linkedinService.createOrganizationPostWithVideo(
            accessToken,
            platformAccountId,
            content || '',
            mediaItem.url,
            metadata?.videoTitle,
          );
        } else {
          result = await this.linkedinService.createPostWithVideo(
            accessToken,
            platformAccountId,
            content || '',
            mediaItem.url,
            metadata?.videoTitle,
            visibility,
          );
        }
      } else {
        throw new Error(`Unsupported media type: ${mediaItem.type}`);
      }
    } else if (metadata?.linkUrl) {
      // Link/article post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPostWithLink(
          accessToken,
          platformAccountId,
          content || '',
          metadata.linkUrl,
          metadata.linkTitle,
          metadata.linkDescription,
        );
      } else {
        result = await this.linkedinService.createPostWithLink(
          accessToken,
          platformAccountId,
          content || '',
          metadata.linkUrl,
          metadata.linkTitle,
          metadata.linkDescription,
          visibility,
        );
      }
    } else {
      // Text-only post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPost(
          accessToken,
          platformAccountId,
          content || '',
        );
      } else {
        result = await this.linkedinService.createPost(
          accessToken,
          platformAccountId,
          content || '',
          visibility,
        );
      }
    }

    this.logger.log(`Published to LinkedIn: ${result.postId}`);

    return {
      platformPostId: result.postId,
      platformPostUrl: `https://www.linkedin.com/feed/update/${result.postId}`,
    };
  }
}
