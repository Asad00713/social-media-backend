import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  ThreadsService,
  ThreadsMediaSettings,
  ThreadsPostSettings,
  ThreadsPoll,
  THREADS_ALT_TEXT_MAX_CHARS,
  parseThreadsPostLink,
} from '../../channels/services/threads.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { isPollAllowed, isPollFormat, threadToPublish } from './post-format';
import { countThreadsChars } from './text-length';

/**
 * A carousel's items: "up to 20 images, videos, or a mix of the two"
 * (Threads API, Posts). The composer counts against the same 20.
 */
const THREADS_MAX_MEDIA = 20;

interface ThreadTweet {
  text: string;
  mediaItems?: MediaItem[];
}

/** The five values `reply_control` accepts. */
const VALID_REPLY_CONTROLS = [
  'everyone',
  'accounts_you_follow',
  'mentioned_only',
  'parent_post_author_only',
  'followers_only',
];

/**
 * Characters Threads rejects in a topic tag, per Meta's publishing
 * reference: periods and ampersands. A tag containing one fails the
 * container create, so it is dropped rather than sent.
 */
const TOPIC_TAG_BANNED = /[.&]/;

/** Threads' own cap on each poll option. */
const POLL_OPTION_MAX_CHARS = 25;

/** `poll_attachment` takes options A-D, and A and B are required. */
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 4;

/** A media item's alt text, trimmed, or undefined when it has none. */
function altTextOf(
  item: { altText?: unknown } | undefined,
): string | undefined {
  const raw = item?.altText;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

/**
 * The settings for an image or video container: the post's own plus that
 * item's alt text. Never used for a text container.
 */
function withAltText(
  settings: ThreadsPostSettings | undefined,
  item: MediaItem,
): ThreadsMediaSettings | undefined {
  const altText = altTextOf(item);
  if (!altText) return settings;
  return { ...(settings ?? {}), altText };
}

/** A carousel item for the service, with its alt text when it has one. */
function carouselItem(m: MediaItem): {
  type: 'IMAGE' | 'VIDEO';
  url: string;
  altText?: string;
} {
  const altText = altTextOf(m);
  return {
    type: m.type === 'video' ? 'VIDEO' : 'IMAGE',
    url: m.url,
    ...(altText ? { altText } : {}),
  };
}

/**
 * The poll to attach, or undefined for none - the Threads twin of X's
 * `xPollToSend`.
 *
 * When the composer picked the Poll format, a poll that cannot be sent
 * FAILS the publish with the reason: Threads only takes a poll on a
 * text-only post ("Polls can only be attached to text-only posts"), with
 * two to four options of at most 25 characters each. It used to be dropped,
 * so the post went out as plain text and showed "Published".
 *
 * A row with no format stored (written before the format existed) keeps
 * the old lenient reading: options are trimmed and capped, and a poll that
 * does not make two options, or rides media, is left out.
 */
export function threadsPollToSend(
  metadata: Record<string, any> | undefined,
  mediaCount: number,
): ThreadsPoll | undefined {
  // A poll left in the draft after switching to Post or Thread is not
  // sent (see post-format.ts).
  if (!isPollAllowed(metadata)) return undefined;
  const raw: unknown = metadata?.poll;
  const rawOptions: unknown =
    raw && typeof raw === 'object'
      ? (raw as { options?: unknown }).options
      : undefined;
  const trimmed: string[] = Array.isArray(rawOptions)
    ? rawOptions
        .filter((o: unknown): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
    : [];

  if (!isPollFormat(metadata)) {
    if (mediaCount > 0) return undefined;
    const options = trimmed.map((o) => o.slice(0, POLL_OPTION_MAX_CHARS));
    if (options.length < POLL_MIN_OPTIONS) return undefined;
    return {
      optionA: options[0],
      optionB: options[1],
      optionC: options[2],
      optionD: options[3],
    };
  }

  if (mediaCount > 0) {
    throw new Error(
      'Threads only allows a poll on a text-only post — remove the media or switch this post to Post',
    );
  }
  if (trimmed.length < POLL_MIN_OPTIONS) {
    throw new Error(
      `A Threads poll needs at least ${POLL_MIN_OPTIONS} filled-in options (${trimmed.length} given) — add options or switch this post to Post`,
    );
  }
  if (trimmed.length > POLL_MAX_OPTIONS) {
    throw new Error(
      `Threads polls allow at most ${POLL_MAX_OPTIONS} options (${trimmed.length} given)`,
    );
  }
  const long = trimmed.find((o) => o.length > POLL_OPTION_MAX_CHARS);
  if (long !== undefined) {
    throw new Error(
      `Poll option "${long}" is over Threads' ${POLL_OPTION_MAX_CHARS}-character limit (${long.length} chars)`,
    );
  }
  return {
    optionA: trimmed[0],
    optionB: trimmed[1],
    optionC: trimmed[2],
    optionD: trimmed[3],
  };
}

/**
 * Refuses alt text over Threads' 1,000 characters before anything is sent:
 * `alt_text` rides the container create, so a long one would fail the post
 * (or a thread half-way, with earlier posts already live).
 */
function assertAltTextFits(
  items: MediaItem[] | undefined,
  where: string,
): void {
  (items ?? []).forEach((item, i) => {
    const alt = altTextOf(item);
    if (alt && alt.length > THREADS_ALT_TEXT_MAX_CHARS) {
      throw new Error(
        `Alt text on ${where}media item ${i + 1} is over Threads' ${THREADS_ALT_TEXT_MAX_CHARS}-character limit (${alt.length} chars)`,
      );
    }
  });
}

/** ISO 3166-1 alpha-2 — what `allowlisted_country_codes` takes. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** What posts 2..N of a thread carry: the country gate alone, if any. */
function replySettings(
  countries: string[] | undefined,
): ThreadsPostSettings | undefined {
  return countries?.length ? { allowlistedCountryCodes: countries } : undefined;
}

@Injectable()
export class ThreadsPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'threads';

  constructor(private readonly threadsService: ThreadsService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    // More settings, checked before anything else so a thread is covered
    // too. Refused rather than dropped: a gate with a mistyped country
    // would publish to the wrong audience.
    const badCode = this.getCountryCodes(metadata).find(
      (c) => !COUNTRY_CODE.test(c),
    );
    if (badCode) {
      throw new Error(`"${badCode}" is not a two-letter country code`);
    }
    const quoteLink = this.getQuoteLink(metadata);
    if (quoteLink && !parseThreadsPostLink(quoteLink)) {
      throw new Error(`"${quoteLink}" is not a link to a Threads post`);
    }

    // The format decides: a thread left in the draft after switching to
    // Post or Poll is not published (see post-format.ts).
    const thread = threadToPublish<ThreadTweet>(metadata);

    if (thread) {
      // Thread mode: validate each post independently.
      thread.forEach((t, i) => {
        const hasMedia = (t.mediaItems?.length ?? 0) > 0;
        if (!t.text && !hasMedia) {
          throw new Error(`Thread post ${i + 1} must have content or media`);
        }
        const counted = countThreadsChars(t.text ?? '');
        if (counted > 500) {
          throw new Error(
            `Thread post ${i + 1} exceeds 500 character limit (${counted} chars)`,
          );
        }
        if ((t.mediaItems?.length ?? 0) > THREADS_MAX_MEDIA) {
          throw new Error(
            `Thread post ${i + 1} has more than ${THREADS_MAX_MEDIA} media items`,
          );
        }
        assertAltTextFits(t.mediaItems, `thread post ${i + 1}, `);
      });
      return;
    }

    // A poll that cannot be sent fails here, before anything is created.
    threadsPollToSend(metadata, mediaItems.length);
    assertAltTextFits(mediaItems, '');

    // Single-post validation
    if (!content && mediaItems.length === 0) {
      throw new Error('Threads post must have content or media');
    }

    // Check character limit
    // Threads counts an emoji as its UTF-8 bytes (Threads API, Posts).
    const counted = countThreadsChars(content ?? '');
    if (counted > 500) {
      throw new Error(
        `Threads content exceeds 500 character limit (${counted} chars)`,
      );
    }

    // Check media limit
    if (mediaItems.length > THREADS_MAX_MEDIA) {
      throw new Error(
        `Threads allows maximum ${THREADS_MAX_MEDIA} media items per carousel`,
      );
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'carousel'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  /**
   * The country codes to gate the post to (the publisher's own key,
   * `allowlistedCountryCodes`), upper-cased. Invalid codes are refused by
   * validate() rather than dropped here: a post meant for two countries
   * must not go out everywhere because one code was mistyped.
   */
  private getCountryCodes(metadata: Record<string, any> | undefined): string[] {
    const raw: unknown = metadata?.allowlistedCountryCodes;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c !== '');
  }

  /** The pasted link of the post to quote (the publisher's own key). */
  private getQuoteLink(
    metadata: Record<string, any> | undefined,
  ): string | undefined {
    const link: unknown = metadata?.quotePostUrl;
    return typeof link === 'string' && link.trim() !== ''
      ? link.trim()
      : undefined;
  }

  /**
   * The post-level settings the composer chose, translated to Threads'
   * own names and values.
   *
   * `reply_control` is forwarded only when it is one of the five values
   * the API accepts. An unrecognised value fails the container create, and
   * losing a reply restriction is better than losing the post — the same
   * rule the X publisher follows.
   */
  private getSettings(
    metadata: Record<string, any> | undefined,
  ): ThreadsPostSettings {
    const settings: ThreadsPostSettings = {};

    const replyControl = metadata?.replyControl;
    if (VALID_REPLY_CONTROLS.includes(replyControl)) {
      settings.replyControl = replyControl;
    }

    // One topic per post. Periods and ampersands are rejected outright, so
    // a tag carrying them is dropped rather than sent — see the note on
    // TOPIC_TAG_BANNED.
    const topicTag = metadata?.topicTag;
    if (typeof topicTag === 'string' && topicTag.trim()) {
      const trimmed = topicTag.trim();
      if (!TOPIC_TAG_BANNED.test(trimmed)) settings.topicTag = trimmed;
    }

    if (metadata?.spoilerMedia === true) settings.isSpoilerMedia = true;
    if (metadata?.reviewReplies === true) settings.enableReplyApprovals = true;

    const locationId = metadata?.locationId;
    if (typeof locationId === 'string' && locationId.trim()) {
      settings.locationId = locationId.trim();
    }

    const countries = this.getCountryCodes(metadata);
    if (countries.length > 0) settings.allowlistedCountryCodes = countries;

    return settings;
  }

  /** The poll to attach to a text post (see `threadsPollToSend`). */
  private getPoll(
    metadata: Record<string, any> | undefined,
    mediaCount: number,
  ): ThreadsPoll | undefined {
    return threadsPollToSend(metadata, mediaCount);
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, metadata } =
      options;

    this.validate(options);

    // Thread mode — composer sets `metadata.thread = [{ text, mediaItems? }, ...]`
    // when posting a multi-post sequence. We publish the first post, then
    // chain subsequent posts via reply_to_id (same pattern as TwitterPublisher).
    const settings = this.getSettings(metadata);

    // The quote is resolved BEFORE anything is created, so a link that is
    // not one of the account's own recent posts fails the publish with
    // nothing live. Not on a poll: Figma offers no quote there.
    const quoteLink = this.getQuoteLink(metadata);
    if (quoteLink && !this.getPoll(metadata, mediaItems.length)) {
      settings.quotePostId = await this.threadsService.findOwnPostByLink(
        accessToken,
        platformAccountId,
        quoteLink,
      );
    }

    const thread = threadToPublish<ThreadTweet>(metadata);
    if (thread) {
      return this.publishThread(
        accessToken,
        platformAccountId,
        thread,
        settings,
      );
    }

    let result: { postId: string };
    const replyToId = metadata?.replyToId as string | undefined;

    if (mediaItems.length === 0) {
      // Text-only post — the only kind a poll can ride, per Meta: "Polls
      // can only be attached to text-only posts."
      result = await this.threadsService.createTextThread(
        accessToken,
        platformAccountId,
        content,
        replyToId,
        { ...settings, poll: this.getPoll(metadata, 0) },
      );
    } else if (mediaItems.length === 1) {
      if (mediaItems[0].type === 'video') {
        result = await this.threadsService.createVideoThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
          withAltText(settings, mediaItems[0]),
        );
      } else {
        result = await this.threadsService.createImageThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
          withAltText(settings, mediaItems[0]),
        );
      }
    } else {
      // Carousel post
      result = await this.threadsService.createCarouselThread(
        accessToken,
        platformAccountId,
        mediaItems.map(carouselItem),
        content,
        replyToId,
        settings,
      );
    }

    this.logger.log(`Published to Threads: ${result.postId}`);

    return {
      platformPostId: result.postId,
    };
  }

  /**
   * Posts a thread: post 1 is the root, posts 2..N each reply to the
   * previous post's id (mirrors TwitterPublisher.publishThread). Returns the
   * ROOT post's id so the channel target's platformPostId points to the head
   * of the thread. If a mid-thread post fails, earlier posts remain live on
   * Threads — we surface the failure and let the user retry from the composer.
   *
   * Shipped but untested with a live account — verify in smoke test.
   */
  private async publishThread(
    accessToken: string,
    platformAccountId: string,
    posts: ThreadTweet[],
    settings?: ThreadsPostSettings,
  ): Promise<PublishResult> {
    let replyToId: string | undefined;
    let rootId: string | undefined;
    const postedIds: string[] = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const media = post.mediaItems ?? [];

      try {
        // The root alone carries them. These describe the post that starts
        // the conversation — `reply_control` governs who may reply to the
        // thread, and `topic_tag` is one topic for the post, not one per
        // reply. Repeating them would set a reply's own reply rules.
        //
        // Countries are the exception, and ride EVERY post. DECISION
        // (reversible here): a reply left ungated would show the thread's
        // continuation in the very countries the root was hidden from.
        const postSettings =
          i === 0 ? settings : replySettings(settings?.allowlistedCountryCodes);

        let res: { postId: string };
        if (media.length === 0) {
          res = await this.threadsService.createTextThread(
            accessToken,
            platformAccountId,
            post.text,
            replyToId,
            postSettings,
          );
        } else if (media.length === 1) {
          if (media[0].type === 'video') {
            res = await this.threadsService.createVideoThread(
              accessToken,
              platformAccountId,
              media[0].url,
              post.text,
              replyToId,
              withAltText(postSettings, media[0]),
            );
          } else {
            res = await this.threadsService.createImageThread(
              accessToken,
              platformAccountId,
              media[0].url,
              post.text,
              replyToId,
              withAltText(postSettings, media[0]),
            );
          }
        } else {
          res = await this.threadsService.createCarouselThread(
            accessToken,
            platformAccountId,
            media.map(carouselItem),
            post.text,
            replyToId,
            postSettings,
          );
        }

        if (!rootId) rootId = res.postId;
        replyToId = res.postId;
        postedIds.push(res.postId);
        this.logger.log(
          `Thread post ${i + 1}/${posts.length} published: ${res.postId}`,
        );
      } catch (err) {
        this.logger.error(
          `Thread broke at post ${i + 1}/${posts.length}. Published so far: ${postedIds.join(',')}`,
        );
        throw err;
      }
    }

    return {
      platformPostId: rootId!,
      metadata: { threadIds: postedIds },
    };
  }
}
