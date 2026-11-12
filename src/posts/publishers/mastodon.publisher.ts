import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  MASTODON_QUOTE_API_VERSION,
  MastodonService,
  type MastodonQuoteApprovalPolicy,
} from '../../channels/services/mastodon.service';
import { toMastodonFocus } from '../../channels/services/mastodon-focus';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { isPollAllowed, isPollFormat, threadToPublish } from './post-format';
import { countMastodonChars } from './text-length';

type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

const QUOTE_POLICIES: readonly MastodonQuoteApprovalPolicy[] = [
  'public',
  'followers',
  'nobody',
];

/**
 * The composer's "Allow quotes" choice (`metadata.allowQuotes`), or undefined.
 *
 * Only one of the API's three values counts. Anything else — a stale draft,
 * a hand-edited request — is left out rather than forwarded, because
 * leaving it out means "use the account's own default", which is the safe
 * reading of a value we do not understand.
 */
function pickQuotePolicy(
  metadata: Record<string, any> | undefined,
): MastodonQuoteApprovalPolicy | undefined {
  const value = metadata?.allowQuotes;
  return QUOTE_POLICIES.find((policy) => policy === value);
}

/**
 * Mastodon's stock poll bounds (`configuration.polls.max_options` is 4 on a
 * stock server; a poll needs two answers to be one). The service keeps only
 * the first four, so a fifth is refused here rather than dropped there.
 */
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 4;

export interface MastodonPoll {
  options: string[];
  expiresInSeconds: number;
  multiple?: boolean;
}

/**
 * The poll to send, or undefined for none - the Mastodon twin of X's
 * `xPollToSend`.
 *
 * When the composer picked the Poll format, a poll that cannot be sent
 * FAILS the publish with the reason: a status carries a poll OR media,
 * never both (`poll` and `media_ids` are mutually exclusive on
 * POST /api/v1/statuses), and `poll[options]` needs at least two answers
 * with a positive `poll[expires_in]`. It used to be dropped, so the post went
 * out as plain text and showed "Published".
 *
 * A row with no format stored (written before the format existed) keeps
 * the old reading: a poll that cannot be sent is left out.
 */
export function mastodonPollToSend(
  metadata: Record<string, any> | undefined,
  mediaCount: number,
): MastodonPoll | undefined {
  // A poll left in the draft after switching to Post or Thread is not
  // sent (see post-format.ts).
  if (!isPollAllowed(metadata)) return undefined;
  const raw: unknown = metadata?.poll;
  const strict = isPollFormat(metadata);
  if (!strict && (!raw || typeof raw !== 'object')) return undefined;

  const poll = (raw && typeof raw === 'object' ? raw : {}) as {
    options?: unknown;
    expiresInSeconds?: unknown;
    multiple?: unknown;
  };
  const options: string[] = Array.isArray(poll.options)
    ? poll.options
        .filter((o: unknown): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];
  const expiresInSeconds = Number(poll.expiresInSeconds);
  const hasDuration = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0;

  if (!strict) {
    // `options` and `expires_in` must be provided together, and a poll
    // needs at least two answers to be one.
    if (options.length < POLL_MIN_OPTIONS || !hasDuration) return undefined;
    return { options, expiresInSeconds, multiple: poll.multiple === true };
  }

  if (mediaCount > 0) {
    throw new Error(
      'Mastodon does not allow a poll and media in the same post — remove the media or switch this post to Post',
    );
  }
  if (options.length < POLL_MIN_OPTIONS) {
    throw new Error(
      `A Mastodon poll needs at least ${POLL_MIN_OPTIONS} filled-in options (${options.length} given) — add options or switch this post to Post`,
    );
  }
  if (options.length > POLL_MAX_OPTIONS) {
    throw new Error(
      `Mastodon polls allow at most ${POLL_MAX_OPTIONS} options (${options.length} given)`,
    );
  }
  if (!hasDuration) {
    throw new Error(
      'The Mastodon poll has no duration — pick how long it runs',
    );
  }
  return { options, expiresInSeconds, multiple: poll.multiple === true };
}

/** The composer's First comment for Mastodon, trimmed, or ''. */
function firstCommentOf(metadata: Record<string, any> | undefined): string {
  return typeof metadata?.firstComment === 'string'
    ? metadata.firstComment.trim()
    : '';
}

/** An https link to a post, as `/api/v2/search` will resolve one. */
const POST_LINK = /^https:\/\/[^/\s]+\.[^/\s]+\/\S*$/i;

/** The pasted link of the post to quote (the publisher's own key), or undefined. */
function draftQuoteLink(
  metadata: Record<string, any> | undefined,
): string | undefined {
  const link: unknown = metadata?.quotePostUrl;
  return typeof link === 'string' && link.trim() !== ''
    ? link.trim()
    : undefined;
}

/**
 * A media item as the composer saves it, with the focal point the photo editor
 * puts on it (`DraftMediaItem.focalPoint`). The post's media is stored as JSON,
 * so the field arrives untyped and is validated by `toMastodonFocus`.
 */
type MediaWithFocalPoint = MediaItem & { focalPoint?: unknown };

/**
 * Mastodon publisher — calls MastodonService against the channel's
 * configured instance URL. Honours metadata.visibility, language, contentWarning,
 * sensitive flags from composer settings panel.
 *
 * NOTE: shipped but untested with a live account — verify in smoke test.
 */
@Injectable()
export class MastodonPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'mastodon';

  constructor(private readonly mastodonService: MastodonService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;
    const quoteLink = draftQuoteLink(metadata);
    if (quoteLink && !POST_LINK.test(quoteLink)) {
      throw new Error(`"${quoteLink}" is not a link to a post`);
    }
    if (!content && mediaItems.length === 0) {
      throw new Error('Mastodon post must have text or media');
    }
    // Counted as Mastodon counts (`status_length_validator.rb`): graphemes,
    // each link 23, and the content warning shares the budget — on every
    // post of a thread too, since each one carries the warning.
    const warning =
      typeof metadata?.contentWarning === 'string'
        ? metadata.contentWarning
        : undefined;
    const thread = threadToPublish<{ text?: string }>(metadata);
    thread?.forEach((t, i) => {
      const counted = countMastodonChars(t.text ?? '', warning);
      if (counted > 500) {
        throw new Error(
          `Mastodon thread post ${i + 1} exceeds 500 character limit (${counted} chars)`,
        );
      }
    });
    const counted = countMastodonChars(content ?? '', warning);
    if (!thread && counted > 500) {
      throw new Error(
        `Mastodon toot exceeds 500 character limit (${counted} chars)`,
      );
    }
    if (mediaItems.length > 4) {
      throw new Error('Mastodon allows maximum 4 media items per post');
    }
    // A poll that cannot be sent fails here, before anything is uploaded.
    if (!threadToPublish(metadata)) {
      mastodonPollToSend(metadata, mediaItems.length);
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.every((m) => ['image', 'video', 'gif'].includes(m.type));
  }

  /** `language` on the status — a BCP-47 code, or undefined. */
  private getLanguage(
    metadata: Record<string, any> | undefined,
  ): string | undefined {
    const language = metadata?.language;
    return typeof language === 'string' && language.trim()
      ? language.trim()
      : undefined;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, channelMetadata, metadata } =
      options;
    this.validate(options);

    const instanceUrl = channelMetadata?.instanceUrl as string | undefined;
    if (!instanceUrl) {
      throw new Error(
        'Mastodon channel is missing instanceUrl — re-connect the account',
      );
    }

    // The quote is settled BEFORE anything is uploaded or posted, so a
    // server too old to quote, or a link it cannot find, fails the publish
    // with nothing live. An older server would otherwise drop the unknown
    // parameter (inferred) and publish text about a post nobody can see.
    const quotedStatusId = await this.resolveQuote(
      instanceUrl,
      accessToken,
      draftQuoteLink(metadata),
    );

    // Thread mode: a reply chain when the format is Thread (or no format was
    // stored) and there is more than one post. A thread left in the draft
    // after switching to Post or Poll is not published (see post-format.ts).
    const thread = threadToPublish<{
      text: string;
      mediaItems?: Array<{
        url: string;
        altText?: string;
        focalPoint?: unknown;
      }>;
    }>(metadata);
    if (thread) {
      return this.publishThread(instanceUrl, accessToken, thread, {
        visibility:
          (metadata?.visibility as MastodonVisibility | undefined) ?? 'public',
        sensitive:
          Boolean(metadata?.sensitive) || Boolean(metadata?.contentWarning),
        spoilerText: metadata?.contentWarning as string | undefined,
        // The composer's Language row. `createStatus` has always set
        // `body.language` when given it; nothing was passing it.
        language: metadata?.language as string | undefined,
        quotedStatusId,
      });
    }

    // Upload media first (Mastodon requires media to be uploaded separately,
    // then attached by ID in the status creation call).
    let mediaIds: string[] | undefined;
    if (mediaItems.length > 0) {
      mediaIds = [];
      for (const m of mediaItems as MediaWithFocalPoint[]) {
        const uploaded = await this.mastodonService.uploadMedia(
          instanceUrl,
          accessToken,
          m.url,
          m.altText,
          undefined,
          toMastodonFocus(m.focalPoint),
        );
        mediaIds.push(uploaded.id);
      }
    }

    const visibility =
      (metadata?.visibility as MastodonVisibility | undefined) ?? 'public';
    const contentWarning = metadata?.contentWarning as string | undefined;
    const sensitive = Boolean(metadata?.sensitive) || Boolean(contentWarning);

    const status = await this.mastodonService.createStatus(
      instanceUrl,
      accessToken,
      content ?? '',
      {
        visibility,
        sensitive,
        spoilerText: contentWarning,
        mediaIds,
        language: this.getLanguage(metadata),
        // A status takes a poll OR attachments, never both; in the Poll
        // format validate() has already refused media beside a poll.
        poll: mastodonPollToSend(metadata, mediaItems.length),
        // Single posts only. The composer's row is absent in a thread, so
        // forwarding a value left over from before the switch would apply
        // a setting nobody can see.
        quoteApprovalPolicy: pickQuotePolicy(metadata),
        quotedStatusId,
      },
    );

    const result: PublishResult = {
      platformPostId: status.id,
      platformPostUrl: status.url,
    };

    // First comment: a reply to the status just posted (`in_reply_to_id`),
    // the way Mastodon threads a conversation. The post is live by now, so a
    // reply that fails is a warning on the result, not a failed post - the
    // same soft step Facebook, Instagram, LinkedIn and YouTube take. It
    // follows the post's visibility, language and content warning, as
    // Mastodon's own reply composer does. Single posts only: the composer
    // has no First comment on a Thread, so one left from before a switch to
    // Thread is not sent (the thread returned above).
    const firstComment = firstCommentOf(metadata);
    if (firstComment.length > 0) {
      try {
        const reply = await this.mastodonService.createStatus(
          instanceUrl,
          accessToken,
          firstComment,
          {
            visibility,
            sensitive,
            spoilerText: contentWarning,
            language: this.getLanguage(metadata),
            inReplyToId: status.id,
          },
        );
        this.logger.log(
          `First comment posted on Mastodon status ${status.id}: ${reply.id}`,
        );
        result.metadata = { firstCommentId: reply.id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `First comment failed on Mastodon status ${status.id}: ${reason}`,
        );
        result.metadata = { firstCommentWarning: reason };
      }
    }

    return result;
  }

  /**
   * The local id of the status to quote, or undefined when there is none.
   *
   * Throws when the server's API is older than 4.5's (version 7): there is
   * no way to quote there, and posting without the quote would publish
   * something other than what was composed.
   */
  private async resolveQuote(
    instanceUrl: string,
    accessToken: string,
    link: string | undefined,
  ): Promise<string | undefined> {
    if (!link) return undefined;
    const version = await this.mastodonService.getApiVersion(instanceUrl);
    if (version < MASTODON_QUOTE_API_VERSION) {
      throw new Error(
        'This Mastodon server does not support quote posts (needs Mastodon 4.5 or later) — remove the quote to publish',
      );
    }
    return this.mastodonService.resolveStatusUrl(
      instanceUrl,
      accessToken,
      link,
    );
  }

  private async publishThread(
    instanceUrl: string,
    accessToken: string,
    posts: Array<{
      text: string;
      mediaItems?: Array<{
        url: string;
        altText?: string;
        focalPoint?: unknown;
      }>;
    }>,
    baseOptions: {
      visibility: MastodonVisibility;
      sensitive: boolean;
      spoilerText?: string;
      language?: string;
      /**
       * Post 1 only. DECISION (reversible here): the design offers "Quote a
       * post" on a thread too, and the quote belongs with the post that
       * opens the conversation rather than repeated on every reply.
       */
      quotedStatusId?: string;
    },
  ): Promise<PublishResult> {
    let replyToId: string | undefined;
    let rootId: string | undefined;
    let rootUrl: string | undefined;
    const postedIds: string[] = [];

    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      const media = p.mediaItems ?? [];

      let mediaIds: string[] | undefined;
      if (media.length > 0) {
        mediaIds = [];
        for (const m of media) {
          const uploaded = await this.mastodonService.uploadMedia(
            instanceUrl,
            accessToken,
            m.url,
            m.altText,
            undefined,
            toMastodonFocus(m.focalPoint),
          );
          mediaIds.push(uploaded.id);
        }
      }

      try {
        const status = await this.mastodonService.createStatus(
          instanceUrl,
          accessToken,
          p.text,
          {
            visibility: baseOptions.visibility,
            sensitive: baseOptions.sensitive,
            spoilerText: baseOptions.spoilerText,
            // Every post in the thread, not just the first: a reply in
            // a different language from its parent is how a thread
            // ends up half-hidden by someone's language filter.
            language: baseOptions.language,
            mediaIds,
            inReplyToId: replyToId,
            quotedStatusId: i === 0 ? baseOptions.quotedStatusId : undefined,
          },
        );
        if (!rootId) {
          rootId = status.id;
          rootUrl = status.url;
        }
        replyToId = status.id;
        postedIds.push(status.id);
        this.logger.log(
          `Mastodon thread post ${i + 1}/${posts.length}: ${status.id}`,
        );
      } catch (err) {
        this.logger.error(
          `Mastodon thread broke at ${i + 1}/${posts.length}. Posted so far: ${postedIds.join(',')}`,
        );
        throw err;
      }
    }

    return {
      platformPostId: rootId!,
      platformPostUrl: rootUrl,
      metadata: { threadIds: postedIds },
    };
  }
}
