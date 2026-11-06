import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

/**
 * Mastodon publisher — calls MastodonService against the channel's
 * configured instance URL. Honours metadata.visibility, contentWarning,
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
    const { content, mediaItems } = options;
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

  /** `language` on the status — a BCP-47 code, or undefined. */
  private getLanguage(
    metadata: Record<string, any> | undefined,
  ): string | undefined {
    const language = metadata?.language;
    return typeof language === 'string' && language.trim()
      ? language.trim()
      : undefined;
  }

  /**
   * The poll, if the composer built one.
   *
   * Validated rather than forwarded: Mastodon rejects the whole status
   * for a malformed poll, so a poll that cannot be sent is dropped and
   * the post survives.
   */
  private getPoll(metadata: Record<string, any> | undefined):
    | { options: string[]; expiresInSeconds: number; multiple?: boolean }
    | undefined {
    const raw = metadata?.poll;
    if (!raw || typeof raw !== 'object') return undefined;

    const options = Array.isArray(raw.options)
      ? raw.options
          .filter((o: unknown): o is string => typeof o === 'string')
          .map((o: string) => o.trim())
          .filter(Boolean)
      : [];
    const expiresInSeconds = Number(raw.expiresInSeconds);

    // `options` and `expires_in` must be provided together, and a poll
    // needs at least two answers to be one.
    if (options.length < 2) return undefined;
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      return undefined;
    }

    return {
      options,
      expiresInSeconds,
      multiple: raw.multiple === true,
    };
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
        language: this.getLanguage(metadata),
        // Dropped by the service when media is present — a status takes a
        // poll OR attachments, never both.
        poll: this.getPoll(metadata),
      },
    );

    return {
      platformPostId: status.id,
      platformPostUrl: status.url,
    };
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
            mediaIds,
            inReplyToId: replyToId,
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
