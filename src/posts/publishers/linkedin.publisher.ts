import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { readSharedThumbnail } from '../lib/shared-thumbnail';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

type LinkedInVisibility = 'PUBLIC' | 'CONNECTIONS';

function normalizeVisibility(value: unknown): LinkedInVisibility {
  if (typeof value !== 'string') return 'PUBLIC';
  const upper = value.toUpperCase();
  return upper === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC';
}

/**
 * The title LinkedIn shows above a document. The Posts API requires one
 * (stated), and the composer carries the uploaded file's own name when it
 * has it; otherwise the last path segment of the stored URL, which for our
 * storage is the file name too.
 */
function documentTitleOf(item: { url: string; filename?: unknown }): string {
  if (typeof item.filename === 'string' && item.filename.trim()) {
    return item.filename.trim();
  }
  try {
    const segment = new URL(item.url).pathname.split('/').pop() ?? '';
    const decoded = decodeURIComponent(segment).trim();
    if (decoded) return decoded;
  } catch {
    // not a URL — fall through to the plain name
  }
  return 'Document';
}

const isDocument = (item: { type: string }) => item.type === 'document';

/**
 * The first link in a block of text — the one the composer draws the card
 * for. Mirrors `findLink` in the frontend (`facebook-post-shape.ts`): the
 * end of the match is deliberately loose, because a trailing full stop or
 * comma belongs to the sentence, not the link.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/i;

function firstUrlIn(text: string): string | undefined {
  return text.match(URL_PATTERN)?.[0];
}

/** `https://www.lumiere.pk/blog` -> `lumiere.pk`, as the card shows it. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const trimmed = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

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
      const q =
        typeof metadata.pollQuestion === 'string'
          ? metadata.pollQuestion.trim()
          : '';
      const opts = Array.isArray(metadata.pollOptions)
        ? (metadata.pollOptions as unknown[]).filter(
            (o): o is string => typeof o === 'string' && o.trim().length > 0,
          )
        : [];
      if (!q) throw new Error('LinkedIn poll requires a question');
      if (opts.length < 2)
        throw new Error('LinkedIn poll requires at least 2 options');
      if (opts.length > 4)
        throw new Error('LinkedIn poll allows at most 4 options');
      return;
    }

    // A document post is its file. The composer only offers the format with
    // one attached, but a stale or hand-built draft should fail here, in words,
    // rather than as a LinkedIn 400 after an upload.
    if (metadata?.postType === 'document') {
      if (!mediaItems.some(isDocument)) {
        throw new Error('LinkedIn document post requires a document file');
      }
      if (content && content.length > 3000) {
        throw new Error(
          `LinkedIn content exceeds 3000 character limit (${content.length} chars)`,
        );
      }
      return;
    }

    // LinkedIn allows text-only posts
    if (!content && mediaItems.length === 0) {
      throw new Error('LinkedIn post must have content or media');
    }

    // Check character limit (LinkedIn allows up to 3000 chars)
    if (content && content.length > 3000) {
      throw new Error(
        `LinkedIn content exceeds 3000 character limit (${content.length} chars)`,
      );
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'document'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const {
      content,
      mediaItems,
      accessToken,
      platformAccountId,
      channelMetadata,
      metadata,
    } = options;

    this.validate(options);

    const isOrganization = channelMetadata?.isOrganization || false;
    const visibility = normalizeVisibility(metadata?.visibility);
    const postType = (metadata?.postType as string | undefined) ?? 'post';
    const actorUrn = isOrganization
      ? `urn:li:organization:${platformAccountId}`
      : `urn:li:person:${platformAccountId}`;
    // `isReshareDisabledByAuthor` exists only on the versioned Posts API.
    // Every format the composer publishes now goes through it - text, image,
    // video, poll, document and link card. The one path left on the legacy
    // `/v2/ugcPosts` is `metadata.linkUrl` without a thumbnail (a scraped
    // card the Posts API cannot make), which the composer never sends.
    const disableReshare = metadata?.reshareDisabled === true;

    // POLL — uses Posts API with content.poll structure
    if (postType === 'poll') {
      const opts = (metadata.pollOptions as string[])
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      const result = await this.linkedinService.createPollPost(
        accessToken,
        actorUrn,
        metadata.pollQuestion as string,
        opts,
        (metadata?.pollDurationDays as number | undefined) ?? 7,
        content ?? '',
        visibility,
        disableReshare,
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
      const headline =
        typeof metadata?.articleHeadline === 'string'
          ? metadata.articleHeadline.trim()
          : '';
      if (headline) {
        effectiveContent = effectiveContent.trim()
          ? `${headline}\n\n${effectiveContent}`
          : headline;
      }
    }

    // A link whose card carries the author's own image. The Posts API does
    // no URL scraping (stated), so this is the one link post that is a card
    // on LinkedIn: without an image the link stays text in the caption, and
    // `metadata.linkUrl` alone still takes the legacy ARTICLE branch below.
    // Attached media wins over it simply by being tested first in the chain
    // below: an image post carries the link as text.
    const cardThumbnail = trimmed(metadata?.linkThumbnailUrl);
    const cardSource = cardThumbnail
      ? trimmed(metadata?.linkUrl) || firstUrlIn(effectiveContent)
      : undefined;

    let result: { postId: string; thumbnailWarning?: string };

    if (postType === 'document') {
      // PDF / Office file: Documents API upload, then a Posts API post.
      const file = mediaItems.find(isDocument);
      if (!file) {
        throw new Error('LinkedIn document post requires a document file');
      }
      result = await this.linkedinService.createDocumentPost(
        accessToken,
        actorUrn,
        effectiveContent,
        file.url,
        documentTitleOf(file as typeof file & { filename?: unknown }),
        visibility,
        disableReshare,
      );
    } else if (mediaItems.length > 0) {
      const mediaItem = mediaItems[0];

      if (mediaItem.type === 'image') {
        // Images API upload, then a Posts API post. A page's post is always
        // PUBLIC: the envelope enforces that for an organization author.
        result = await this.linkedinService.createRestImagePost(
          accessToken,
          actorUrn,
          effectiveContent,
          mediaItem.url,
          trimmed(metadata?.imageTitle) || undefined,
          visibility,
          disableReshare,
        );
      } else if (mediaItem.type === 'video') {
        // Videos API multipart upload, then a Posts API post. It carries
        // YouTube's designed thumbnail when the post has one
        // (`sharedThumbnailUrl`); one that cannot be sent is a warning.
        const thumbnailUrl = readSharedThumbnail(metadata);
        result = await this.linkedinService.createRestVideoPost(
          accessToken,
          actorUrn,
          effectiveContent,
          mediaItem.url,
          trimmed(metadata?.videoTitle) || undefined,
          visibility,
          disableReshare,
          thumbnailUrl ? { thumbnailUrl } : {},
        );
      } else {
        throw new Error(`Unsupported media type: ${mediaItem.type}`);
      }
    } else if (cardSource) {
      // Images API upload, then a Posts API article carrying it.
      result = await this.linkedinService.createArticlePostWithThumbnail(
        accessToken,
        actorUrn,
        effectiveContent,
        {
          source: cardSource,
          // Required by the API (stated) and not scraped, so it is what the
          // card shows: the author's title, else the site's name.
          title: (trimmed(metadata?.linkTitle) || domainOf(cardSource)).slice(
            0,
            399,
          ),
          description:
            trimmed(metadata?.linkDescription).slice(0, 4085) || undefined,
          thumbnailUrl: cardThumbnail,
        },
        visibility,
        disableReshare,
      );
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
      // Text-only post (an article's headline is already merged in).
      result = await this.linkedinService.createRestTextPost(
        accessToken,
        actorUrn,
        effectiveContent,
        visibility,
        disableReshare,
      );
    }

    this.logger.log(`Published to LinkedIn: ${result.postId}`);

    const publishResult: PublishResult = {
      platformPostId: result.postId,
      platformPostUrl: `https://www.linkedin.com/feed/update/${result.postId}`,
    };

    // The video is live, so a thumbnail that could not be sent is a warning
    // on the result, like a first comment's failure - not a failed post.
    if (result.thumbnailWarning) {
      publishResult.metadata = {
        ...(publishResult.metadata ?? {}),
        thumbnailWarning: result.thumbnailWarning,
      };
    }

    const firstComment =
      typeof metadata?.firstComment === 'string'
        ? metadata.firstComment.trim()
        : '';
    if (firstComment.length > 0) {
      try {
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
