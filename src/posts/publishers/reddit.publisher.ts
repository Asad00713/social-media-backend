import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { RedditService } from '../../channels/services/reddit.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

type RedditKind = 'self' | 'link' | 'image';

/**
 * Reddit publisher. Routes by metadata.postType:
 *   - 'self' (default) → text post, body becomes `text` (markdown)
 *   - 'link' → metadata.linkUrl required, posted as a link submission
 *   - 'image' → mediaItems[0].url posted as an image submission
 *
 * Required metadata fields (set by RedditPanel in composer):
 *   - subreddit (without "r/" prefix)
 *   - title (max 300 chars)
 * Optional:
 *   - flairId, nsfw, spoiler, sendReplies, linkUrl
 *
 * NOTE: shipped but untested with a live account — verify in smoke test.
 */
@Injectable()
export class RedditPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'reddit';

  constructor(private readonly redditService: RedditService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;
    const title = metadata?.title as string | undefined;
    const subreddit = metadata?.subreddit as string | undefined;
    const postType = ((metadata?.postType as RedditKind | undefined) ?? 'self');

    if (!subreddit) {
      throw new Error('Reddit post requires a subreddit');
    }
    if (!title || title.trim().length === 0) {
      throw new Error('Reddit post requires a title');
    }
    if (title.length > 300) {
      throw new Error(`Reddit title exceeds 300 character limit (${title.length} chars)`);
    }

    if (postType === 'image') {
      if (mediaItems.length === 0) {
        throw new Error('Reddit image posts require an image');
      }
      if (mediaItems[0].type !== 'image') {
        throw new Error('Reddit image post media must be an image');
      }
    } else if (postType === 'link') {
      const linkUrl = (metadata?.linkUrl as string | undefined) ?? '';
      if (!linkUrl) {
        throw new Error('Reddit link post requires a URL');
      }
    } else {
      // self / text post
      if (content && content.length > 40000) {
        throw new Error(`Reddit selftext exceeds 40,000 character limit`);
      }
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.every((m) => m.type === 'image');
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, metadata } = options;
    this.validate(options);

    const kind = ((metadata?.postType as RedditKind | undefined) ?? 'self');
    const subreddit = (metadata?.subreddit as string).replace(/^r\//, '');
    const title = metadata?.title as string;

    const submitOpts: Parameters<RedditService['submit']>[1] = {
      subreddit,
      kind,
      title,
      flairId: metadata?.flairId as string | undefined,
      flairText: metadata?.flairText as string | undefined,
      nsfw: Boolean(metadata?.nsfw),
      spoiler: Boolean(metadata?.spoiler),
      sendReplies: metadata?.sendReplies !== false,
    };

    if (kind === 'image') {
      submitOpts.url = mediaItems[0].url;
    } else if (kind === 'link') {
      submitOpts.url = metadata?.linkUrl as string;
    } else {
      submitOpts.text = content ?? '';
    }

    const result = await this.redditService.submit(accessToken, submitOpts);
    this.logger.log(`Published to Reddit r/${subreddit}: ${result.name}`);

    return {
      platformPostId: result.name,
      platformPostUrl: result.url.startsWith('http')
        ? result.url
        : `https://www.reddit.com${result.url}`,
    };
  }
}
