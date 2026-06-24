import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { BlueskyService } from '../../channels/services/bluesky.service';
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

    const thread = metadata?.thread as ThreadPost[] | undefined;
    if (Array.isArray(thread) && thread.length > 1) {
      return this.publishThread(accessToken, did, thread);
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
      );
    } else if (mediaItems.length === 1 && mediaItems[0].type === 'video') {
      const v = mediaItems[0];
      post = await this.blueskyService.createVideoPost(
        accessToken,
        did,
        content ?? '',
        v.url,
        v.altText,
      );
    } else {
      post = await this.blueskyService.createImagePost(
        accessToken,
        did,
        content ?? '',
        mediaItems.map((m) => m.url),
        mediaItems.map((m) => m.altText ?? ''),
      );
    }

    const rkey = post.uri.split('/').pop() ?? '';
    const handle = (channelMetadata?.handle as string | undefined) ?? did;
    return {
      platformPostId: post.uri,
      platformPostUrl: `https://bsky.app/profile/${handle}/post/${rkey}`,
    };
  }

  private async publishThread(
    accessJwt: string,
    did: string,
    posts: ThreadPost[],
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
          );
        } else if (isVideoItem) {
          created = await this.blueskyService.createVideoPost(
            accessJwt,
            did,
            p.text,
            media[0].url,
            media[0].altText,
            reply,
          );
        } else {
          created = await this.blueskyService.createImagePost(
            accessJwt,
            did,
            p.text,
            media.map((m) => m.url),
            media.map((m) => m.altText ?? ''),
            reply,
          );
        }

        const ref = { uri: created.uri, cid: created.cid };
        if (i === 0) {
          rootRef = ref;
          rootUri = created.uri;
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
