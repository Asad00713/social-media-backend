import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

type LinkedInVisibility = 'PUBLIC' | 'CONNECTIONS';

function normalizeVisibility(value: unknown): LinkedInVisibility {
  if (typeof value !== 'string') return 'PUBLIC';
  const upper = value.toUpperCase();
  return upper === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC';
}

@Injectable()
export class LinkedInPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'linkedin';

  constructor(private readonly linkedinService: LinkedInService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    if (metadata?.postType === 'poll') {
      // Polls don't need text/media; question + 2 options is enough.
      const q = typeof metadata.pollQuestion === 'string' ? metadata.pollQuestion.trim() : '';
      const opts = Array.isArray(metadata.pollOptions)
        ? (metadata.pollOptions as unknown[]).filter(
            (o): o is string => typeof o === 'string' && o.trim().length > 0,
          )
        : [];
      if (!q) throw new Error('LinkedIn poll requires a question');
      if (opts.length < 2) throw new Error('LinkedIn poll requires at least 2 options');
      if (opts.length > 4) throw new Error('LinkedIn poll allows at most 4 options');
      return;
    }

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
    const visibility = normalizeVisibility(metadata?.visibility);
    const postType = (metadata?.postType as string | undefined) ?? 'post';

    // POLL — uses Posts API with content.poll structure
    if (postType === 'poll') {
      const actorUrn = isOrganization
        ? `urn:li:organization:${platformAccountId}`
        : `urn:li:person:${platformAccountId}`;
      const opts = (metadata!.pollOptions as string[])
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      const result = await this.linkedinService.createPollPost(
        accessToken,
        actorUrn,
        metadata!.pollQuestion as string,
        opts,
        (metadata?.pollDurationDays as number | undefined) ?? 7,
        content ?? '',
        visibility,
      );

      const publishResult: PublishResult = {
        platformPostId: result.postId,
        platformPostUrl: `https://www.linkedin.com/feed/update/${result.postId}`,
      };
      return publishResult;
    }

    // ARTICLE — pragmatic implementation: merge headline + body into a regular post.
    // (LinkedIn's native long-form Article API `/originalArticles` requires Marketing
    // Developer Platform approval which we don't have. This matches what Buffer/Hootsuite
    // do — the headline becomes the visually prominent first line in feed.)
    let effectiveContent = content ?? '';
    if (postType === 'article') {
      const headline = typeof metadata?.articleHeadline === 'string'
        ? metadata.articleHeadline.trim()
        : '';
      if (headline) {
        effectiveContent = effectiveContent.trim()
          ? `${headline}\n\n${effectiveContent}`
          : headline;
      }
    }

    let result: { postId: string };

    if (mediaItems.length > 0) {
      const mediaItem = mediaItems[0];

      if (mediaItem.type === 'image') {
        // Image post
        if (isOrganization) {
          result = await this.linkedinService.createOrganizationPostWithImage(
            accessToken,
            platformAccountId,
            effectiveContent,
            mediaItem.url,
            metadata?.imageTitle,
          );
        } else {
          result = await this.linkedinService.createPostWithImage(
            accessToken,
            platformAccountId,
            effectiveContent,
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
            effectiveContent,
            mediaItem.url,
            metadata?.videoTitle,
          );
        } else {
          result = await this.linkedinService.createPostWithVideo(
            accessToken,
            platformAccountId,
            effectiveContent,
            mediaItem.url,
            metadata?.videoTitle,
            visibility,
          );
        }
      } else {
        throw new Error(`Unsupported media type: ${mediaItem.type}`);
      }
    } else if (metadata?.linkUrl) {
      // Link post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPostWithLink(
          accessToken,
          platformAccountId,
          effectiveContent,
          metadata.linkUrl,
          metadata.linkTitle,
          metadata.linkDescription,
        );
      } else {
        result = await this.linkedinService.createPostWithLink(
          accessToken,
          platformAccountId,
          effectiveContent,
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
          effectiveContent,
        );
      } else {
        result = await this.linkedinService.createPost(
          accessToken,
          platformAccountId,
          effectiveContent,
          visibility,
        );
      }
    }

    this.logger.log(`Published to LinkedIn: ${result.postId}`);

    const publishResult: PublishResult = {
      platformPostId: result.postId,
      platformPostUrl: `https://www.linkedin.com/feed/update/${result.postId}`,
    };

    const firstComment = typeof metadata?.firstComment === 'string'
      ? metadata.firstComment.trim()
      : '';
    if (firstComment.length > 0) {
      try {
        const actorUrn = isOrganization
          ? `urn:li:organization:${platformAccountId}`
          : `urn:li:person:${platformAccountId}`;
        const comment = await this.linkedinService.postComment(
          accessToken,
          actorUrn,
          result.postId,
          firstComment,
        );
        this.logger.log(
          `First comment posted on LinkedIn post ${result.postId}: ${comment.commentUrn}`,
        );
        publishResult.metadata = {
          ...(publishResult.metadata ?? {}),
          firstCommentUrn: comment.commentUrn,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on LinkedIn post ${result.postId}: ${reason}`,
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
