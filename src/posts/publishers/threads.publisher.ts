import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { ThreadsService } from '../../channels/services/threads.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface ThreadTweet {
  text: string;
  mediaItems?: MediaItem[];
}

@Injectable()
export class ThreadsPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'threads';

  constructor(private readonly threadsService: ThreadsService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { content, mediaItems, metadata } = options;

    const thread = metadata?.thread as ThreadTweet[] | undefined;

    if (Array.isArray(thread) && thread.length > 1) {
      // Thread mode: validate each post independently.
      thread.forEach((t, i) => {
        const hasMedia = (t.mediaItems?.length ?? 0) > 0;
        if (!t.text && !hasMedia) {
          throw new Error(`Thread post ${i + 1} must have content or media`);
        }
        if (t.text && t.text.length > 500) {
          throw new Error(
            `Thread post ${i + 1} exceeds 500 character limit (${t.text.length} chars)`,
          );
        }
        if ((t.mediaItems?.length ?? 0) > 10) {
          throw new Error(`Thread post ${i + 1} has more than 10 media items`);
        }
      });
      return;
    }

    // Single-post validation
    if (!content && mediaItems.length === 0) {
      throw new Error('Threads post must have content or media');
    }

    // Check character limit
    if (content && content.length > 500) {
      throw new Error(`Threads content exceeds 500 character limit (${content.length} chars)`);
    }

    // Check media limit
    if (mediaItems.length > 10) {
      throw new Error('Threads allows maximum 10 media items per carousel');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    const supportedTypes = ['image', 'video', 'carousel'];
    return mediaItems.every((m) => supportedTypes.includes(m.type));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, platformAccountId, metadata } = options;

    this.validate(options);

    // Thread mode — composer sets `metadata.thread = [{ text, mediaItems? }, ...]`
    // when posting a multi-post sequence. We publish the first post, then
    // chain subsequent posts via reply_to_id (same pattern as TwitterPublisher).
    const thread = metadata?.thread as ThreadTweet[] | undefined;
    if (Array.isArray(thread) && thread.length > 1) {
      return this.publishThread(accessToken, platformAccountId, thread);
    }

    let result: { postId: string };
    const replyToId = metadata?.replyToId as string | undefined;

    if (mediaItems.length === 0) {
      // Text-only post
      result = await this.threadsService.createTextThread(
        accessToken,
        platformAccountId,
        content,
        replyToId,
      );
    } else if (mediaItems.length === 1) {
      if (mediaItems[0].type === 'video') {
        result = await this.threadsService.createVideoThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
        );
      } else {
        result = await this.threadsService.createImageThread(
          accessToken,
          platformAccountId,
          mediaItems[0].url,
          content,
          replyToId,
        );
      }
    } else {
      // Carousel post
      result = await this.threadsService.createCarouselThread(
        accessToken,
        platformAccountId,
        mediaItems.map((m) => ({
          type: m.type === 'video' ? ('VIDEO' as const) : ('IMAGE' as const),
          url: m.url,
        })),
        content,
        replyToId,
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
  ): Promise<PublishResult> {
    let replyToId: string | undefined;
    let rootId: string | undefined;
    const postedIds: string[] = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const media = post.mediaItems ?? [];

      try {
        let res: { postId: string };
        if (media.length === 0) {
          res = await this.threadsService.createTextThread(
            accessToken,
            platformAccountId,
            post.text,
            replyToId,
          );
        } else if (media.length === 1) {
          if (media[0].type === 'video') {
            res = await this.threadsService.createVideoThread(
              accessToken,
              platformAccountId,
              media[0].url,
              post.text,
              replyToId,
            );
          } else {
            res = await this.threadsService.createImageThread(
              accessToken,
              platformAccountId,
              media[0].url,
              post.text,
              replyToId,
            );
          }
        } else {
          res = await this.threadsService.createCarouselThread(
            accessToken,
            platformAccountId,
            media.map((m) => ({
              type: m.type === 'video' ? ('VIDEO' as const) : ('IMAGE' as const),
              url: m.url,
            })),
            post.text,
            replyToId,
          );
        }

        if (!rootId) rootId = res.postId;
        replyToId = res.postId;
        postedIds.push(res.postId);
        this.logger.log(`Thread post ${i + 1}/${posts.length} published: ${res.postId}`);
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
