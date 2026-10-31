import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  TwitterService,
  TwitterOAuth1Credentials,
} from '../../channels/services/twitter.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/** X's `reply_settings` write enum — note it has no `everyone`. */
type TwitterReplySettings =
  | 'following'
  | 'mentionedUsers'
  | 'subscribers'
  | 'verified';

/** X's two disclosure booleans, as `createTweet` takes them. */
interface TwitterDisclosures {
  madeWithAi?: boolean;
  paidPartnership?: boolean;
}

const VALID_REPLY_SETTINGS: TwitterReplySettings[] = [
  'following',
  'mentionedUsers',
  'subscribers',
  'verified',
];

@Injectable()
export class TwitterPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'twitter';

  constructor(private readonly twitterService: TwitterService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    const thread = metadata?.thread as
      | Array<{ text: string; mediaItems?: MediaItem[] }>
      | undefined;

    if (Array.isArray(thread) && thread.length > 1) {
      // Thread mode: validate each tweet independently.
      thread.forEach((t, i) => {
        const hasMedia = (t.mediaItems?.length ?? 0) > 0;
        if (!t.text && !hasMedia) {
          throw new Error(`Thread tweet ${i + 1} must have content or media`);
        }
        if (t.text && t.text.length > 280) {
          throw new Error(
            `Thread tweet ${i + 1} exceeds 280 character limit (${t.text.length} chars)`,
          );
        }
        if ((t.mediaItems?.length ?? 0) > 4) {
          throw new Error(`Thread tweet ${i + 1} has more than 4 media items`);
        }
      });
      return;
    }

    // Single-tweet validation
    if (!content && mediaItems.length === 0) {
      throw new Error('Twitter post must have content or media');
    }
    if (content && content.length > 280) {
      throw new Error(
        `Twitter content exceeds 280 character limit (${content.length} chars)`,
      );
    }
    if (mediaItems.length > 4) {
      throw new Error('Twitter allows maximum 4 media items per post');
    }

    // Poll validation
    const poll = metadata?.poll;
    if (poll) {
      if (mediaItems.length > 0) {
        throw new Error('Twitter polls cannot be combined with media');
      }
      if (
        !Array.isArray(poll.options) ||
        poll.options.length < 2 ||
        poll.options.length > 4
      ) {
        throw new Error('Twitter polls must have 2-4 options');
      }
      for (const option of poll.options) {
        if (
          typeof option !== 'string' ||
          option.length < 1 ||
          option.length > 25
        ) {
          throw new Error('Each poll option must be 1-25 characters');
        }
      }
      const duration = poll.durationMinutes;
      if (typeof duration !== 'number' || duration < 5 || duration > 10080) {
        throw new Error(
          'Poll duration must be between 5 and 10080 minutes (7 days)',
        );
      }
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'gif'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, channelMetadata, metadata } =
      options;

    this.validate(options);

    const oauth1Credentials = this.getOAuth1Credentials(channelMetadata);

    // Thread mode — composer sets `metadata.thread = [{ text, mediaItems? }, ...]`
    // when posting a multi-tweet sequence. We publish the first tweet, then
    // chain subsequent tweets via in_reply_to_tweet_id.
    const thread = metadata?.thread as
      | Array<{ text: string; mediaItems?: MediaItem[] }>
      | undefined;

    if (Array.isArray(thread) && thread.length > 1) {
      return this.publishThread(
        accessToken,
        thread,
        oauth1Credentials,
        this.getReplySettings(metadata),
        this.getDisclosures(metadata),
      );
    }

    // Single-tweet mode (default)
    let mediaIds: string[] | undefined;
    if (mediaItems && mediaItems.length > 0) {
      mediaIds = await this.uploadMediaItems(
        accessToken,
        mediaItems,
        oauth1Credentials,
      );
    }

    const pollData = metadata?.poll;
    const poll = pollData
      ? {
          options: pollData.options as string[],
          durationMinutes: pollData.durationMinutes as number,
        }
      : undefined;

    const result = await this.twitterService.createTweet(accessToken, content, {
      mediaIds,
      poll,
      replySettings: this.getReplySettings(metadata),
      ...this.getDisclosures(metadata),
    });

    this.logger.log(`Published tweet: ${result.id}`);

    return {
      platformPostId: result.id,
      platformPostUrl: `https://twitter.com/i/web/status/${result.id}`,
    };
  }

  /**
   * Posts a thread: tweet 1 is the root, tweets 2..N each reply to the
   * previous tweet's id. Returns the ROOT tweet's id/url so the channel
   * target's platformPostUrl points to the head of the thread. If a
   * mid-thread post fails, earlier tweets remain live on Twitter — we
   * surface the failure and let the user retry from the composer.
   */
  private async publishThread(
    accessToken: string,
    tweets: Array<{ text: string; mediaItems?: MediaItem[] }>,
    oauth1Credentials: TwitterOAuth1Credentials | undefined,
    replySettings?: TwitterReplySettings,
    disclosures?: TwitterDisclosures,
  ): Promise<PublishResult> {
    let replyToId: string | undefined;
    let rootId: string | undefined;
    const postedIds: string[] = [];

    for (let i = 0; i < tweets.length; i++) {
      const tweet = tweets[i];

      let mediaIds: string[] | undefined;
      if (tweet.mediaItems && tweet.mediaItems.length > 0) {
        mediaIds = await this.uploadMediaItems(
          accessToken,
          tweet.mediaItems,
          oauth1Credentials,
        );
      }

      try {
        const result = await this.twitterService.createTweet(
          accessToken,
          tweet.text,
          {
            mediaIds,
            replyToTweetId: replyToId,
            // Only the root post carries it. X applies the conversation's
            // reply rules from the post that starts it, and sending it on
            // a reply restricts replies to that reply instead.
            replySettings: i === 0 ? replySettings : undefined,
            // Unlike the reply rules, a disclosure rides EVERY post in the
            // thread. `reply_settings` describes the conversation, so the
            // root owns it; `made_with_ai` describes the media attached to
            // the post carrying it, and the composer offers one toggle for
            // the thread rather than one per post. Setting it on the root
            // alone would leave posts 2..N undisclosed.
            ...disclosures,
          },
        );
        if (!rootId) rootId = result.id;
        replyToId = result.id;
        postedIds.push(result.id);
        this.logger.log(
          `Thread tweet ${i + 1}/${tweets.length} posted: ${result.id}`,
        );
      } catch (err) {
        this.logger.error(
          `Thread broke at tweet ${i + 1}/${tweets.length}. Posted so far: ${postedIds.join(',')}`,
        );
        throw err;
      }
    }

    return {
      platformPostId: rootId!,
      platformPostUrl: `https://twitter.com/i/web/status/${rootId}`,
      metadata: { threadIds: postedIds },
    };
  }

  /**
   * What to send as `reply_settings`, or undefined to leave it unset.
   *
   * `everyone` is the composer's word for "no restriction" and is NOT in
   * X's write enum, so it maps to an omitted field. Anything unrecognised
   * is dropped rather than forwarded: a value X does not know fails the
   * whole request, and losing a reply restriction is better than losing
   * the post.
   */
  private getReplySettings(
    metadata: Record<string, any> | undefined,
  ): TwitterReplySettings | undefined {
    const value = metadata?.replyControl;
    return VALID_REPLY_SETTINGS.includes(value as TwitterReplySettings)
      ? (value as TwitterReplySettings)
      : undefined;
  }

  /**
   * The disclosure flags to send, if any.
   *
   * Only a `true` is forwarded. The request schema sets
   * `additionalProperties: false`, and a disclosure is a claim about the
   * post — an absent field says "not disclosed", so there is nothing for
   * a `false` to express that omission does not. Both need only
   * `tweet.write`, which our X channels already hold.
   */
  private getDisclosures(
    metadata: Record<string, any> | undefined,
  ): TwitterDisclosures {
    const disclosures: TwitterDisclosures = {};
    if (metadata?.madeWithAi === true) disclosures.madeWithAi = true;
    if (metadata?.paidPartnership === true) disclosures.paidPartnership = true;
    return disclosures;
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
