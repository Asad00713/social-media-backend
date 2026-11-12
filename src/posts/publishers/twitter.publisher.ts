import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  TwitterService,
  TwitterOAuth1Credentials,
} from '../../channels/services/twitter.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { fetchPublicMedia } from '../../common/net/public-fetch';
import { isPollAllowed, isPollFormat, threadToPublish } from './post-format';
import { countXChars } from './text-length';

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

/** `media.tagged_user_ids` takes at most 10 (stated, POST /2/tweets). */
const MAX_TAGGED_USERS = 10;

/** An X username: letters, digits and underscores, 1-15 characters. */
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;

/** The draft's tagged usernames (the publisher's own key), without `@`. */
function draftTagPeople(metadata: Record<string, any> | undefined): string[] {
  const raw: unknown = metadata?.tagPeople;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().replace(/^@+/, ''))
    .filter((n) => n !== '');
}

const VALID_REPLY_SETTINGS: TwitterReplySettings[] = [
  'following',
  'mentionedUsers',
  'subscribers',
  'verified',
];

/** The most characters one post may carry — counted the way validate() does. */
const MAX_TWEET_CHARS = 280;

/**
 * The texts of a thread as published, numbered when `numberPosts` is on.
 *
 * DECISION (owner-approved, #58): ` n/N` after each post's text, counted
 * INSIDE the 280 — so validate() measures the numbered text, not the typed
 * one. A media-only post gets the number alone. The composer computes the
 * same text in `src/features/composer-v2/lib/x-thread-numbering.ts` for its
 * counter and Checks; the two must change together, or a post the counter
 * calls fine is refused here.
 */
export function numberedThreadTexts(
  texts: string[],
  isNumbered: boolean,
): string[] {
  if (!isNumbered) return texts;
  const total = texts.length;
  return texts.map((text, i) => {
    const suffix = `${i + 1}/${total}`;
    return (text ?? '').trim() === '' ? suffix : `${text} ${suffix}`;
  });
}

/** X's poll limits (POST /2/tweets `poll`). */
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 4;
const POLL_OPTION_MAX_CHARS = 25;
const POLL_MIN_MINUTES = 5;
const POLL_MAX_MINUTES = 10080;

/** A poll as `createTweet` sends it. */
export interface XPoll {
  options: string[];
  durationMinutes: number;
}

/**
 * The `altTextWarning` for a result, when any alt text could not be set:
 * the first reason, with a count when several media items failed.
 */
function altTextWarningOf(failures: string[]): {
  metadata?: { altTextWarning: string };
} {
  if (failures.length === 0) return {};
  const more =
    failures.length > 1
      ? ` (and ${failures.length - 1} more media item${failures.length > 2 ? 's' : ''})`
      : '';
  return { metadata: { altTextWarning: `${failures[0]}${more}` } };
}

/**
 * The poll to send with a single post, or undefined when there is none.
 * Throws when the post IS a poll that X would refuse, so the failure says
 * why instead of the poll quietly becoming a text post.
 *
 * - Only when the format is Poll, or (legacy rows) no format was stored and
 *   a poll is: a poll left in the draft after switching to Post is not sent.
 * - Blank options are dropped first. The composer starts a poll with empty
 *   option rows, and an empty one is not an answer — X would refuse the
 *   whole post over it ("1-25 characters").
 * - Poll format with fewer than two filled options fails: publishing the
 *   text alone would post something other than what was composed.
 * - X refuses a poll together with media, so that fails too.
 */
export function xPollToSend(
  metadata: Record<string, any> | undefined,
  mediaCount: number,
): XPoll | undefined {
  if (!isPollAllowed(metadata)) return undefined;
  const raw: unknown = metadata?.poll;
  const isPoll = isPollFormat(metadata);
  if (!isPoll && (raw === undefined || raw === null)) return undefined;

  const poll = (raw && typeof raw === 'object' ? raw : {}) as {
    options?: unknown;
    durationMinutes?: unknown;
  };
  const options = Array.isArray(poll.options)
    ? poll.options
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter((o) => o !== '')
    : [];

  if (mediaCount > 0) {
    throw new Error(
      'X does not allow a poll and media in the same post — remove the media or switch this post to Post',
    );
  }
  if (options.length < POLL_MIN_OPTIONS) {
    throw new Error(
      `An X poll needs at least ${POLL_MIN_OPTIONS} filled-in options (${options.length} given) — add options or switch this post to Post`,
    );
  }
  if (options.length > POLL_MAX_OPTIONS) {
    throw new Error(
      `X polls allow at most ${POLL_MAX_OPTIONS} options (${options.length} given)`,
    );
  }
  const long = options.find((o) => o.length > POLL_OPTION_MAX_CHARS);
  if (long !== undefined) {
    throw new Error(
      `Poll option "${long}" is over X's ${POLL_OPTION_MAX_CHARS}-character limit (${long.length} chars)`,
    );
  }
  const duration = poll.durationMinutes;
  if (
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration < POLL_MIN_MINUTES ||
    duration > POLL_MAX_MINUTES
  ) {
    throw new Error(
      'Poll duration must be between 5 and 10080 minutes (7 days)',
    );
  }
  return { options, durationMinutes: duration };
}

/** Whether the composer's "Number posts" is on (its own key). */
function isNumbered(metadata: Record<string, any> | undefined): boolean {
  return metadata?.numberPosts === true;
}

@Injectable()
export class TwitterPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'twitter';

  constructor(private readonly twitterService: TwitterService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    // The format decides: a thread left in the draft after switching to
    // Post or Poll is not published (see post-format.ts).
    const thread = threadToPublish<{ text: string; mediaItems?: MediaItem[] }>(
      metadata,
    );

    if (thread) {
      // Thread mode: validate each tweet independently — as it will be
      // SENT, so a number added by "Number posts" counts toward the 280.
      const sent = numberedThreadTexts(
        thread.map((t) => t.text),
        isNumbered(metadata),
      );
      thread.forEach((t, i) => {
        const hasMedia = (t.mediaItems?.length ?? 0) > 0;
        if (!t.text && !hasMedia) {
          throw new Error(`Thread tweet ${i + 1} must have content or media`);
        }
        const text = sent[i];
        const weighted = countXChars(text ?? '');
        if (weighted > MAX_TWEET_CHARS) {
          throw new Error(
            `Thread tweet ${i + 1} exceeds 280 character limit (${weighted} chars${
              isNumbered(metadata) ? ', with its number' : ''
            })`,
          );
        }
        if ((t.mediaItems?.length ?? 0) > 4) {
          throw new Error(`Thread tweet ${i + 1} has more than 4 media items`);
        }
      });
      return;
    }

    // Tagged people (single posts): refused before anything is uploaded.
    const tagged = draftTagPeople(metadata);
    const badName = tagged.find((n) => !X_USERNAME.test(n));
    if (badName) {
      throw new Error(`"@${badName}" is not an X username`);
    }
    if (tagged.length > MAX_TAGGED_USERS) {
      throw new Error(
        `X allows at most ${MAX_TAGGED_USERS} tagged people (${tagged.length} given)`,
      );
    }

    // Single-tweet validation
    if (!content && mediaItems.length === 0) {
      throw new Error('Twitter post must have content or media');
    }
    // Weighted, as X counts: a link is 23 and an emoji 2.
    const weighted = countXChars(content ?? '');
    if (weighted > MAX_TWEET_CHARS) {
      throw new Error(
        `Twitter content exceeds 280 character limit (${weighted} chars as X counts them)`,
      );
    }
    if (mediaItems.length > 4) {
      throw new Error('Twitter allows maximum 4 media items per post');
    }

    // Poll: blank options dropped, a Poll with too few refused, a poll
    // beside media refused (X does not take both).
    xPollToSend(metadata, mediaItems.length);
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
    const thread = threadToPublish<{ text: string; mediaItems?: MediaItem[] }>(
      metadata,
    );

    if (thread) {
      const texts = numberedThreadTexts(
        thread.map((t) => t.text),
        isNumbered(metadata),
      );
      return this.publishThread(
        accessToken,
        thread.map((t, i) => ({ ...t, text: texts[i] })),
        oauth1Credentials,
        this.getReplySettings(metadata),
        this.getDisclosures(metadata),
      );
    }

    // Single-tweet mode (default)
    // Tagged people ride the photos, so they are looked up only when there
    // is a photo to carry them — and BEFORE uploading, so an unknown name
    // fails the publish with nothing live.
    const taggedUserIds = await this.resolveTaggedUsers(
      accessToken,
      draftTagPeople(metadata),
      mediaItems,
    );

    let mediaIds: string[] | undefined;
    const altTextFailures: string[] = [];
    if (mediaItems && mediaItems.length > 0) {
      mediaIds = await this.uploadMediaItems(
        accessToken,
        mediaItems,
        oauth1Credentials,
        altTextFailures,
      );
    }

    const poll = xPollToSend(metadata, mediaItems.length);

    const result = await this.twitterService.createTweet(accessToken, content, {
      mediaIds,
      poll,
      replySettings: this.getReplySettings(metadata),
      ...this.getDisclosures(metadata),
      taggedUserIds,
    });

    this.logger.log(`Published tweet: ${result.id}`);

    return {
      platformPostId: result.id,
      platformPostUrl: `https://twitter.com/i/web/status/${result.id}`,
      ...altTextWarningOf(altTextFailures),
    };
  }

  /**
   * The user ids for the tagged usernames, or undefined when nothing is to
   * be tagged. Only with at least one photo: X attaches `tagged_user_ids`
   * to the media (INFERRED that a video or GIF does not carry tags, from
   * X's own composer, which offers tagging on photos only).
   */
  private async resolveTaggedUsers(
    accessToken: string,
    usernames: string[],
    mediaItems: MediaItem[],
  ): Promise<string[] | undefined> {
    if (usernames.length === 0) return undefined;
    if (!mediaItems.some((m) => m.type === 'image')) return undefined;
    const ids = await this.twitterService.lookupUserIds(accessToken, usernames);
    const missing = usernames.filter((n) => !ids.has(n.toLowerCase()));
    if (missing.length > 0) {
      throw new Error(`X has no account @${missing.join(', @')} to tag`);
    }
    return usernames.map((n) => ids.get(n.toLowerCase())!);
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
    const altTextFailures: string[] = [];

    for (let i = 0; i < tweets.length; i++) {
      const tweet = tweets[i];

      let mediaIds: string[] | undefined;
      if (tweet.mediaItems && tweet.mediaItems.length > 0) {
        mediaIds = await this.uploadMediaItems(
          accessToken,
          tweet.mediaItems,
          oauth1Credentials,
          altTextFailures,
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

    const warning = altTextWarningOf(altTextFailures).metadata;
    return {
      platformPostId: rootId!,
      platformPostUrl: `https://twitter.com/i/web/status/${rootId}`,
      metadata: { threadIds: postedIds, ...warning },
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
   * Download and upload media items to Twitter.
   *
   * Each item's alt text (`MediaItem.altText`) is set on the uploaded media
   * before the post that attaches it. It is a soft step: the media is
   * already uploaded, and a description X will not take must not cost the
   * post, so a failure is pushed onto `altTextFailures` and the post goes
   * out (reported back as `altTextWarning`).
   */
  private async uploadMediaItems(
    accessToken: string,
    mediaItems: MediaItem[],
    oauth1Credentials?: TwitterOAuth1Credentials,
    altTextFailures: string[] = [],
  ): Promise<string[]> {
    const mediaIds: string[] = [];

    for (const item of mediaItems) {
      try {
        // Download the media from URL
        const response = await fetchPublicMedia(item.url);
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

      const altText =
        typeof item.altText === 'string' ? item.altText.trim() : '';
      if (altText) {
        const mediaId = mediaIds[mediaIds.length - 1];
        try {
          await this.twitterService.setMediaAltText(
            accessToken,
            mediaId,
            altText,
            oauth1Credentials,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Alt text not set on X media ${mediaId}: ${reason}`);
          altTextFailures.push(reason);
        }
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
