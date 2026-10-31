import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import {
  BlueskyService,
  BlueskyPostSettings,
  threadgateAllow,
} from '../../channels/services/bluesky.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface ThreadPost {
  text: string;
  mediaItems?: MediaItem[];
}

/**
 * Bluesky publisher — AT Protocol via BlueskyService.
 * The decrypted "accessToken" passed into publish() is the Bluesky
 * `accessJwt` string. The user's DID lives on the channel metadata.
 *
 * NOTE: shipped but untested with a live account — verify in smoke test.
 */
@Injectable()
export class BlueskyPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'bluesky';

  constructor(private readonly blueskyService: BlueskyService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    const thread = metadata?.thread as ThreadPost[] | undefined;
    if (Array.isArray(thread) && thread.length > 1) {
      thread.forEach((t, i) => {
        const media = t.mediaItems ?? [];
        if (!t.text && media.length === 0) {
          throw new Error(
            `Bluesky thread post ${i + 1} must have content or media`,
          );
        }
        if (t.text && t.text.length > 300) {
          throw new Error(
            `Bluesky thread post ${i + 1} exceeds 300 character limit (${t.text.length} chars)`,
          );
        }
        const hasVideo = media.some((m) => m.type === 'video');
        if (hasVideo && media.length > 1) {
          throw new Error(
            `Bluesky thread post ${i + 1} can include either images OR one video — not both`,
          );
        }
        if (!hasVideo && media.length > 4) {
          throw new Error(
            `Bluesky thread post ${i + 1} has more than 4 images`,
          );
        }
      });
      return;
    }

    if (!content && mediaItems.length === 0) {
      throw new Error('Bluesky post must have text, images, or a video');
    }
    if (content && content.length > 300) {
      throw new Error(
        `Bluesky post exceeds 300 character limit (${content.length} chars)`,
      );
    }
    const hasVideo = mediaItems.some((m) => m.type === 'video');
    if (hasVideo && mediaItems.length > 1) {
      throw new Error(
        'Bluesky posts can include either images OR one video — not both',
      );
    }
    if (!hasVideo && mediaItems.length > 4) {
      throw new Error('Bluesky allows maximum 4 images per post');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    // Bluesky supports images (up to 4) and a single video (MP4/MOV up to 1GB).
    // Mixed media (image + video) is NOT supported — must be one or the other.
    if (mediaItems.length === 0) return true;
    const allImages = mediaItems.every((m) => m.type === 'image');
    const isSingleVideo =
      mediaItems.length === 1 && mediaItems[0].type === 'video';
    return allImages || isSingleVideo;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, channelMetadata, metadata } =
      options;
    this.validate(options);

    const did =
      (channelMetadata?.did as string | undefined) ?? options.platformAccountId;
    if (!did) {
      throw new Error(
        'Bluesky channel is missing DID — re-connect the account',
      );
    }

    const settings = this.getSettings(metadata);

    const thread = metadata?.thread as ThreadPost[] | undefined;
    if (Array.isArray(thread) && thread.length > 1) {
      return this.publishThread(accessToken, did, thread, settings);
    }

    // Pick the right service method based on media shape.
    // - No media → text post
    // - 1 video → video post (uploadBlob with the video binary)
    // - 1-4 images → image post(s)
    let post: { uri: string; cid: string };
    if (mediaItems.length === 0) {
      post = await this.blueskyService.createTextPost(
        accessToken,
        did,
        content ?? '',
        undefined,
        settings,
      );
    } else if (mediaItems.length === 1 && mediaItems[0].type === 'video') {
      const v = mediaItems[0];
      post = await this.blueskyService.createVideoPost(
        accessToken,
        did,
        content ?? '',
        v.url,
        v.altText,
        undefined,
        settings,
      );
    } else {
      post = await this.blueskyService.createImagePost(
        accessToken,
        did,
        content ?? '',
        mediaItems.map((m) => m.url),
        mediaItems.map((m) => m.altText ?? ''),
        undefined,
        settings,
      );
    }

    await this.applyReplyControl(accessToken, did, post.uri, settings);

    const rkey = post.uri.split('/').pop() ?? '';
    const handle = (channelMetadata?.handle as string | undefined) ?? did;
    return {
      platformPostId: post.uri,
      platformPostUrl: `https://bsky.app/profile/${handle}/post/${rkey}`,
    };
  }

  /**
   * The post settings, in Bluesky's own vocabulary.
   *
   * `langs` is a list because the lexicon says so — the composer picks
   * one, but the field takes up to three, and sending the list keeps the
   * shape honest for whatever picks more later.
   */
  private getSettings(
    metadata: Record<string, any> | undefined,
  ): BlueskyPostSettings {
    const settings: BlueskyPostSettings = {};

    const language = metadata?.language;
    if (typeof language === 'string' && language.trim()) {
      settings.langs = [language.trim()];
    }

    const replyControl = metadata?.replyControl;
    if (
      replyControl === 'everybody' ||
      replyControl === 'nobody' ||
      replyControl === 'custom'
    ) {
      settings.replyControl = replyControl;
    }

    const rules = metadata?.replyRules;
    if (rules && typeof rules === 'object') {
      settings.replyRules = {
        followers: rules.followers === true,
        following: rules.following === true,
        mentioned: rules.mentioned === true,
      };
    }

    return settings;
  }

  /**
   * Writes the threadgate, if the author restricted replies.
   *
   * Deliberately NOT fatal. The post is already live at this point, and
   * failing the publish here would report a failure for something that
   * succeeded — and invite a retry that double-posts. The restriction is
   * lost and said so in the log; the post is not.
   */
  private async applyReplyControl(
    accessJwt: string,
    did: string,
    postUri: string,
    settings: BlueskyPostSettings,
  ): Promise<void> {
    const allow = threadgateAllow(settings);
    if (allow === null) return;

    try {
      await this.blueskyService.setPostReplyControl(
        accessJwt,
        did,
        postUri,
        allow,
      );
    } catch (err) {
      this.logger.error(
        `Bluesky post ${postUri} published, but its reply restriction did not: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async publishThread(
    accessJwt: string,
    did: string,
    posts: ThreadPost[],
    settings?: BlueskyPostSettings,
  ): Promise<PublishResult> {
    let rootRef: { uri: string; cid: string } | undefined;
    let parentRef: { uri: string; cid: string } | undefined;
    let rootUri: string | undefined;
    const postedUris: string[] = [];

    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];

      // For posts after the first, AT Protocol requires BOTH root and parent refs.
      // Root = the very first post; parent = the immediately preceding post.
      const reply =
        i === 0 ? undefined : { root: rootRef!, parent: parentRef! };

      try {
        // Branch on media type — Bluesky uses different embed types for
        // image (app.bsky.embed.images) vs video (app.bsky.embed.video).
        // Routing video through createImagePost trips the
        // "Expected image/* (got video/mp4)" lexicon validation error.
        const media = p.mediaItems ?? [];
        const isVideoItem = media.length === 1 && media[0].type === 'video';
        let created: { uri: string; cid: string };
        if (media.length === 0) {
          created = await this.blueskyService.createTextPost(
            accessJwt,
            did,
            p.text,
            reply,
            settings,
          );
        } else if (isVideoItem) {
          created = await this.blueskyService.createVideoPost(
            accessJwt,
            did,
            p.text,
            media[0].url,
            media[0].altText,
            reply,
            settings,
          );
        } else {
          created = await this.blueskyService.createImagePost(
            accessJwt,
            did,
            p.text,
            media.map((m) => m.url),
            media.map((m) => m.altText ?? ''),
            reply,
            settings,
          );
        }

        const ref = { uri: created.uri, cid: created.cid };
        if (i === 0) {
          rootRef = ref;
          rootUri = created.uri;
          // The ROOT alone. A threadgate governs a conversation, and the
          // conversation is the one this post starts; putting one on a
          // reply would restrict replies to that reply instead.
          await this.applyReplyControl(
            accessJwt,
            did,
            created.uri,
            settings ?? {},
          );
        }
        parentRef = ref;
        postedUris.push(created.uri);
        this.logger.log(
          `Bluesky thread post ${i + 1}/${posts.length}: ${created.uri}`,
        );
      } catch (err) {
        this.logger.error(
          `Bluesky thread broke at ${i + 1}/${posts.length}. Posted so far: ${postedUris.join(',')}`,
        );
        throw err;
      }
    }

    return {
      platformPostId: rootUri!,
      metadata: { threadUris: postedUris },
    };
  }
}
