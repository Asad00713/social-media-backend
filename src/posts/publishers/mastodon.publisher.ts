import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  MASTODON_QUOTE_API_VERSION,
  MastodonService,
  type MastodonQuoteApprovalPolicy,
} from '../../channels/services/mastodon.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

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
    if (content && content.length > 500) {
      throw new Error(
        `Mastodon toot exceeds 500 character limit (${content.length} chars)`,
      );
    }
    if (mediaItems.length > 4) {
      throw new Error('Mastodon allows maximum 4 media items per post');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.every((m) => ['image', 'video', 'gif'].includes(m.type));
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

    // Thread mode: if metadata.thread is a non-empty array > 1, publish as a reply chain
    const thread = metadata?.thread as
      | Array<{
          text: string;
          mediaItems?: Array<{ url: string; altText?: string }>;
        }>
      | undefined;
    if (Array.isArray(thread) && thread.length > 1) {
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
      for (const m of mediaItems) {
        const uploaded = await this.mastodonService.uploadMedia(
          instanceUrl,
          accessToken,
          m.url,
          m.altText,
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
        language: metadata?.language as string | undefined,
        // Single posts only. The composer's row is absent in a thread, so
        // forwarding a value left over from before the switch would apply
        // a setting nobody can see.
        quoteApprovalPolicy: pickQuotePolicy(metadata),
        quotedStatusId,
      },
    );

    return {
      platformPostId: status.id,
      platformPostUrl: status.url,
    };
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
      mediaItems?: Array<{ url: string; altText?: string }>;
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
