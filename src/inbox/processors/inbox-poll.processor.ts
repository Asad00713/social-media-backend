import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { QUEUES } from '../../queue/queue.module';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import { ChannelService } from '../../channels/services/channel.service';
import { InboxDispatcher } from '../services/inbox-dispatcher.service';
import { InboxService } from '../inbox.service';
import type { ResolvedChannel } from '../adapters/inbox-adapter.interface';

export interface InboxPollJob {
  channelId: number;
}

const POLLING_WINDOW_DAYS = 30;
const MAX_POSTS_PER_RUN = 30;
const SLACK_MS = 60 * 1000; // 1 min — overlap with previous fetch so we don't miss boundary comments

/**
 * Fetches new comments on recent published posts for a single channel.
 * Only used for platforms WITHOUT webhooks (YouTube, Bluesky, Mastodon).
 *
 * Strategy:
 *   1. Resolve channel (decrypts token via ChannelService)
 *   2. Find the latest N published posts targeting this channel in last 30d
 *   3. For each post, call adapter.fetchComments(since = lastInboxPollAt - 1min)
 *   4. Upsert each comment — duplicates are dropped by the unique constraint
 *   5. Update channel.lastInboxPollAt
 *
 * Failure mode: one bad post shouldn't stop the rest of the channel. Each post
 * is wrapped in try/catch.
 */
@Processor(QUEUES.INBOX_POLLING)
export class InboxPollProcessor extends WorkerHost {
  private readonly logger = new Logger(InboxPollProcessor.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly dispatcher: InboxDispatcher,
    private readonly inboxService: InboxService,
  ) {
    super();
  }

  async process(job: Job<InboxPollJob>): Promise<{ ok: boolean; ingested: number }> {
    if (job.name !== 'poll') return { ok: true, ingested: 0 };
    const { channelId } = job.data;

    const channelRow = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, channelId),
    });
    if (!channelRow) {
      this.logger.warn(`Inbox poll: channel ${channelId} not found`);
      return { ok: false, ingested: 0 };
    }

    const platform = channelRow.platform as SupportedPlatform;
    if (!this.dispatcher.supports(platform)) {
      this.logger.verbose(
        `Inbox poll: skipping unsupported platform '${platform}' for channel ${channelId}`,
      );
      return { ok: true, ingested: 0 };
    }

    const since = channelRow.lastInboxPollAt
      ? new Date(channelRow.lastInboxPollAt.getTime() - SLACK_MS)
      : undefined;

    // Decrypt token + shape adapter input.
    let channel: ResolvedChannel;
    try {
      const accessToken = await this.channelService.getAccessToken(
        channelId,
        channelRow.workspaceId,
      );
      channel = {
        id: channelRow.id,
        workspaceId: channelRow.workspaceId,
        platform,
        platformAccountId: channelRow.platformAccountId,
        accessToken,
        metadata: (channelRow.metadata ?? {}) as Record<string, any>,
        username: channelRow.username,
        accountName: channelRow.accountName,
        profilePictureUrl: channelRow.profilePictureUrl,
      };
    } catch (err) {
      this.logger.error(
        `Inbox poll: failed to resolve channel ${channelId} (${platform}, account=${channelRow.platformAccountId}): ${(err as Error).message}`,
      );
      return { ok: false, ingested: 0 };
    }

    // Pull the most recent published posts targeting this channel within window.
    const windowStart = new Date(Date.now() - POLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recent = await db
      .select({
        id: posts.id,
        targets: posts.targets,
        content: posts.content,
        publishedAt: posts.publishedAt,
        platformContent: posts.platformContent,
        mediaItems: posts.mediaItems,
      })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, channelRow.workspaceId),
          eq(posts.status, 'published'),
          gte(posts.publishedAt, windowStart),
          // jsonb-contains: ensure this channel is one of the targets
          sql`${posts.targets} @> ${JSON.stringify([
            { channelId: String(channelId) },
          ])}::jsonb`,
        ),
      )
      .orderBy(desc(posts.publishedAt))
      .limit(MAX_POSTS_PER_RUN);

    const adapter = this.dispatcher.get(platform);
    let ingested = 0;
    let fetched = 0;
    let duplicates = 0;

    for (const post of recent) {
      const target = (post.targets ?? []).find(
        (t: PostTarget) => String(t.channelId) === String(channelId),
      );
      if (!target?.platformPostId) continue;

      try {
        const items = await adapter.fetchComments(
          channel,
          target.platformPostId,
          since,
        );

        // Per-post debug line so it's obvious which posts return 0 — helps
        // diagnose "I commented but inbox is empty" issues. Cheap log, runs
        // once per post per poll.
        this.logger.debug(
          `Inbox poll: ${platform} post ${target.platformPostId} returned ${items.length} comments (since=${since?.toISOString() ?? 'never'})`,
        );

        fetched += items.length;
        for (const item of items) {
          const inserted = await this.inboxService.upsertComment({
            workspaceId: channelRow.workspaceId,
            channelId,
            platform,
            platformItemId: item.platformItemId,
            platformParentId: item.platformParentId,
            // Adapter can override the post id (e.g. Bluesky remaps chained-
            // reply URIs back to the canonical root). Falls back to target.
            platformPostId: item.platformPostId ?? target.platformPostId,
            ourPostId: post.id,
            authorPlatformId: item.authorPlatformId,
            authorHandle: item.authorHandle,
            authorDisplayName: item.authorDisplayName,
            authorAvatarUrl: item.authorAvatarUrl,
            text: item.text,
            fromMe: item.fromMe,
            likeCount: item.likeCount,
            platformCreatedAt: item.platformCreatedAt,
            postSnapshot: {
              id: target.platformPostId,
              caption: post.content,
              publishedAt: post.publishedAt?.toISOString(),
              platformPostUrl: target.platformPostUrl,
              mediaType: deriveMediaType(post.mediaItems),
              thumbnailUrl: deriveThumbnail(post.mediaItems),
            },
            metadata: item.metadata,
          });
          if (inserted) ingested += 1;
          else duplicates += 1;
        }
      } catch (err) {
        this.logger.error(
          `Inbox poll: fetch failed for post ${post.id} (${target.platformPostId}) on channel ${channelId}: ${(err as Error).message}`,
        );
        // Continue with next post — don't fail the whole channel.
      }
    }

    // Mark channel as polled even if no new items — prevents thrashing on next cron.
    await db
      .update(socialMediaChannels)
      .set({ lastInboxPollAt: new Date(), updatedAt: new Date() })
      .where(eq(socialMediaChannels.id, channelId));

    this.logger.log(
      `Inbox poll: channel ${channelId} (${platform}) — posts:${recent.length} fetched:${fetched} new:${ingested} dup:${duplicates}`,
    );

    return { ok: true, ingested };
  }
}

function deriveMediaType(
  items: { type?: string }[] | null | undefined,
): 'image' | 'video' | 'none' {
  if (!items?.length) return 'none';
  if (items.some((m) => m.type === 'video')) return 'video';
  if (items.some((m) => m.type === 'image' || m.type === 'gif')) return 'image';
  return 'none';
}

function deriveThumbnail(
  items: { url?: string; thumbnailUrl?: string; type?: string }[] | null | undefined,
): string | undefined {
  if (!items?.length) return undefined;
  const first = items[0];
  return first.thumbnailUrl ?? first.url;
}
