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
import { FacebookService } from '../../channels/services/facebook.service';
import { InstagramService } from '../../channels/services/instagram.service';
import { InboxDispatcher } from '../services/inbox-dispatcher.service';
import { InboxService } from '../inbox.service';
import type { ResolvedChannel } from '../adapters/inbox-adapter.interface';
import { YoutubeInboxBudgetService } from '../services/youtube-inbox-budget.service';

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
// A full channel poll iterates up to 30 posts + DM convos sequentially against
// the platform APIs. Facebook's `/{post}/comments` can take 1–3s per call,
// plus DM list + per-convo fetches. Multiplied across the loop, total wall
// time often exceeds BullMQ's default 30s lock window, producing
// "Missing lock for job" + `code: -2` errors when the worker tries to
// finish/move the job after the lock expired.
//
// Bump the lock to 10 min (well above worst-case poll time) and renew it
// every 30 s so the redis-side TTL stays fresh even when individual platform
// calls block for several seconds each.
@Processor(QUEUES.INBOX_POLLING, {
  lockDuration: 10 * 60 * 1000,
  lockRenewTime: 30 * 1000,
})
export class InboxPollProcessor extends WorkerHost {
  private readonly logger = new Logger(InboxPollProcessor.name);

  /**
   * Channels we've already attempted to (re-)subscribe to Meta webhook events
   * during this backend process lifetime. The subscribe call is idempotent
   * but costs a Graph API hit, so we only fire it once per channel per
   * restart — a safety net for cases where the OAuth-time subscribe got lost
   * (Meta dropped it, token refreshed, etc).
   */
  private readonly webhookSubscribedChannels = new Set<number>();

  constructor(
    private readonly channelService: ChannelService,
    private readonly dispatcher: InboxDispatcher,
    private readonly inboxService: InboxService,
    private readonly facebookService: FacebookService,
    private readonly instagramService: InstagramService,
    private readonly youtubeBudget: YoutubeInboxBudgetService,
  ) {
    super();
  }

  async process(
    job: Job<InboxPollJob>,
  ): Promise<{ ok: boolean; ingested: number }> {
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
        metadata: channelRow.metadata ?? {},
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

    // Self-heal the IG webhook id for channels connected before we started
    // storing it. Instagram webhooks key off the professional-account id
    // (`user_id`), which we now persist as metadata.igWebhookId at connect
    // time — but pre-existing channels lack it, so their realtime events
    // can't resolve a channel. Backfill it opportunistically on the poll path
    // (token already decrypted here); runs once per channel, then the guard
    // short-circuits. Best-effort — a failure never blocks the poll.
    if (platform === 'instagram' && !channel.metadata?.igWebhookId) {
      await this.backfillInstagramWebhookId(channel).catch((err) => {
        this.logger.warn(
          `Inbox poll: IG webhook-id backfill skipped for channel ${channelId}: ${(err as Error).message}`,
        );
      });
    }

    // Phase 2.3 — lazy webhook subscription. Once per backend lifetime per
    // channel, try to re-arm the Meta webhook subscription for FB Pages + IG
    // Business accounts. Idempotent on Meta's side; this is the safety net
    // for cases where the OAuth-time subscribe failed or got dropped (token
    // refresh, channel re-connect, Meta-side eviction). Fire-and-forget so a
    // webhook failure never delays the poll itself.
    if (
      (platform === 'facebook' || platform === 'instagram') &&
      !this.webhookSubscribedChannels.has(channelId)
    ) {
      this.webhookSubscribedChannels.add(channelId);
      void this.ensureWebhookSubscription(channel, platform);
    }

    // Pull the most recent published posts targeting this channel within window.
    const windowStart = new Date(
      Date.now() - POLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
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

    // YouTube: tier + budget gate. Every other platform polls every post
    // every cycle, as before.
    let youtubeAllowed: Set<string> | null = null;
    if (platform === 'youtube') {
      const candidates = recent
        .map((post) => {
          const t = (post.targets ?? []).find(
            (x: PostTarget) => String(x.channelId) === String(channelId),
          );
          return t?.platformPostId
            ? { platformPostId: t.platformPostId, publishedAt: post.publishedAt }
            : null;
        })
        .filter((c): c is { platformPostId: string; publishedAt: Date | null } =>
          Boolean(c),
        );
      try {
        youtubeAllowed = await this.selectYoutubeTargets(channelId, candidates);
      } catch (err) {
        // The budget gate lives in Redis; if Redis is unreachable here, fail
        // toward polling everything (this cycle only) rather than polling
        // nothing. Polling nothing degrades silently — a Redis blip would
        // quietly stop YouTube comment ingestion with no error anywhere.
        // Polling everything fails in the more observable direction: if it
        // ever actually runs the channel out of quota, that shows up loudly
        // as quotaExceeded errors elsewhere in this pipeline, which is a
        // failure someone will notice and can act on.
        this.logger.error(
          `Inbox poll: YouTube budget gate failed for channel ${channelId}, polling all candidates this cycle: ${(err as Error).message}`,
        );
        youtubeAllowed = null;
      }
    }

    for (const post of recent) {
      const target = (post.targets ?? []).find(
        (t: PostTarget) => String(t.channelId) === String(channelId),
      );
      if (!target?.platformPostId) continue;
      if (youtubeAllowed && !youtubeAllowed.has(target.platformPostId)) continue;

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
        // Mark AFTER the fetch AND the upsert loop have both succeeded. If
        // markPolled runs before the upserts and then throws, the surrounding
        // catch logs "fetch failed" even though the fetch succeeded, and the
        // comments that were already fetched and upserted above are fine —
        // but running markPolled first meant a bookkeeping-only failure could
        // previously discard them by being conflated with a fetch failure.
        // Running it last means a markPolled throw only costs a redundant
        // poll next cycle (the video stays "due"), never lost data. A throw
        // leaves the video due either way, so the next cycle retries instead
        // of skipping it for a whole interval.
        if (platform === 'youtube') {
          await this.youtubeBudget.markPolled(
            channelId,
            target.platformPostId,
            Date.now(),
          );
        }
      } catch (err) {
        this.logger.error(
          `Inbox poll: fetch failed for post ${post.id} (${target.platformPostId}) on channel ${channelId}: ${(err as Error).message}`,
        );
        // Continue with next post — don't fail the whole channel.
      }
    }

    // Threads mentions ingest as account-level items (not tied to a post).
    if (adapter.fetchMentions) {
      try {
        const mentions = await adapter.fetchMentions(channel, since);
        for (const m of mentions) {
          const inserted = await this.inboxService.upsertMention({
            workspaceId: channelRow.workspaceId,
            channelId,
            platform,
            platformItemId: m.platformItemId,
            platformParentId: m.platformParentId,
            authorHandle: m.authorHandle,
            authorDisplayName: m.authorDisplayName,
            authorAvatarUrl: m.authorAvatarUrl,
            text: m.text,
            platformCreatedAt: m.platformCreatedAt,
            fromMe: m.fromMe,
            metadata: m.metadata,
          });
          if (inserted) ingested += 1;
        }
      } catch (err) {
        this.logger.warn(
          `Mentions poll failed (channel=${channelId}): ${(err as Error).message}`,
        );
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // DM polling — Phase 2.1
    //
    // Platforms with webhook DM delivery (FB Messenger) use the webhook path
    // and skip polling. Bluesky / Mastodon have no DM webhook surface and
    // must poll. Instagram is webhook-capable in theory but Meta blocks all
    // real-event delivery in app dev mode — the dashboard warns:
    //   "No production data, including from app admins, developers or
    //    testers, will be delivered unless the app has been published."
    // So until App Review unlocks live mode, IG DMs are also polled.
    //
    // Strategy: list DM conversations since the last poll, then for each
    // conversation fetch messages since the same cutoff. Each message
    // dedups via the (channel_id, platform_item_id) unique constraint.
    // ──────────────────────────────────────────────────────────────────────
    let dmIngested = 0;
    if (
      this.dispatcher.supportsDm(platform) &&
      (platform === 'bluesky' ||
        platform === 'mastodon' ||
        platform === 'instagram')
    ) {
      try {
        const dmAdapter = this.dispatcher.getDm(platform);
        const conversations = await dmAdapter.listConversations(channel, since);
        this.logger.debug(
          `Inbox DM poll: ${platform} channel ${channelId} returned ${conversations.length} conversations (since=${since?.toISOString() ?? 'never'})`,
        );

        for (const convo of conversations) {
          try {
            const messages = await dmAdapter.fetchConversationMessages(
              channel,
              convo.conversationId,
              since,
            );
            for (const msg of messages) {
              // Author enrichment fallback: Bluesky's getMessages only returns
              // `sender.did` (no handle/name/avatar) — fill from the convo's
              // participant data (which IS richer because listConvos returns
              // members[]). For Mastodon, messages already carry rich author
              // info, so this no-ops via the ?? chain.
              const isFromParticipant =
                !msg.fromMe &&
                msg.author?.platformId === convo.participant.platformId;
              const authorHandle =
                msg.author?.handle ??
                (isFromParticipant ? (convo.participant.handle ?? null) : null);
              const authorDisplayName =
                msg.author?.displayName ??
                (isFromParticipant
                  ? (convo.participant.displayName ?? null)
                  : null);
              const authorAvatarUrl =
                msg.author?.avatarUrl ??
                (isFromParticipant
                  ? (convo.participant.avatarUrl ?? null)
                  : null);

              const inserted = await this.inboxService.upsertDm({
                workspaceId: channelRow.workspaceId,
                channelId,
                platform,
                conversationId: msg.conversationId,
                platformItemId: msg.platformItemId,
                platformParentId: msg.platformParentId,
                authorPlatformId: msg.author?.platformId ?? null,
                authorHandle,
                authorDisplayName,
                authorAvatarUrl,
                text: msg.text,
                fromMe: msg.fromMe,
                platformCreatedAt: msg.platformCreatedAt,
                metadata: msg.metadata,
                attachments: msg.attachments,
              });
              if (inserted) dmIngested += 1;
            }
          } catch (err) {
            this.logger.error(
              `Inbox DM poll: convo ${convo.conversationId} on channel ${channelId} (${platform}) failed: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        // Bluesky chat scope gating returns 403 — listConvos in the service
        // already logs + returns []. Anything else is a real error; log it
        // but don't fail the whole channel poll (comments succeeded above).
        this.logger.error(
          `Inbox DM poll: ${platform} channel ${channelId} list failed: ${(err as Error).message}`,
        );
      }
    }

    // Mark channel as polled even if no new items — prevents thrashing on next cron.
    await db
      .update(socialMediaChannels)
      .set({ lastInboxPollAt: new Date(), updatedAt: new Date() })
      .where(eq(socialMediaChannels.id, channelId));

    this.logger.log(
      `Inbox poll: channel ${channelId} (${platform}) — posts:${recent.length} fetched:${fetched} new:${ingested} dup:${duplicates} dmNew:${dmIngested}`,
    );

    return { ok: true, ingested: ingested + dmIngested };
  }

  /**
   * Narrow a YouTube channel's candidate videos to the ones due for a comment
   * poll right now and affordable within today's unit allowance.
   *
   * Returns the set of platformPostIds allowed through. Only YouTube goes
   * through this gate — other platforms have different quota models and keep
   * their existing every-cycle behavior.
   */
  private async selectYoutubeTargets(
    channelId: number,
    candidates: Array<{
      platformPostId: string;
      publishedAt: Date | null | undefined;
    }>,
  ): Promise<Set<string>> {
    const now = Date.now();
    const selection = await this.youtubeBudget.selectDue(
      channelId,
      candidates.map((c) => ({
        videoId: c.platformPostId,
        // No publishedAt means no age, so it cannot be tiered. Treat it as
        // brand new: polling it once too often is far cheaper than dropping
        // it and never polling it again.
        publishedAtMs: c.publishedAt ? c.publishedAt.getTime() : now,
      })),
      now,
    );
    return new Set(selection.due.map((c) => c.videoId));
  }

  /**
   * Re-arm Meta webhook subscription for an FB Page or IG Business account.
   * Called lazily once per channel per backend lifetime as a safety net for
   * cases where the OAuth-time subscribe got lost. Best-effort, errors only
   * surface in logs.
   */
  private async ensureWebhookSubscription(
    channel: ResolvedChannel,
    platform: SupportedPlatform,
  ): Promise<void> {
    try {
      if (platform === 'facebook') {
        await this.facebookService.subscribePageToWebhooks(
          channel.platformAccountId,
          channel.accessToken,
          [
            'feed',
            'messages',
            'messaging_postbacks',
            'message_deliveries',
            'message_reads',
            'message_reactions',
            'message_echoes',
            'message_edits',
          ],
        );
        this.logger.log(
          `Webhook subscribe (FB) re-armed for channel ${channel.id} (page=${channel.platformAccountId})`,
        );
      } else if (platform === 'instagram') {
        await this.instagramService.subscribeAccountToWebhooks(
          channel.platformAccountId,
          channel.accessToken,
          ['comments', 'messages', 'messaging_postbacks', 'message_reactions'],
        );
        this.logger.log(
          `Webhook subscribe (IG) re-armed for channel ${channel.id} (ig=${channel.platformAccountId})`,
        );
      }
    } catch (err) {
      // Don't escalate — polling continues as the fallback.
      this.logger.warn(
        `Webhook auto-subscribe failed for channel ${channel.id} (${platform}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Backfill metadata.igWebhookId for a legacy Instagram channel.
   *
   * Fetches the account's `user_id` (the id IG webhooks send as entry.id) with
   * the channel's own token and merges it into the metadata JSONB, preserving
   * every other key. Only runs when the key is absent (guarded by the caller),
   * so it's a one-time self-heal per channel.
   */
  private async backfillInstagramWebhookId(
    channel: ResolvedChannel,
  ): Promise<void> {
    const info = await this.instagramService.getAccountInfoWithUserToken(
      channel.accessToken,
    );
    if (!info.userId) {
      this.logger.warn(
        `Inbox poll: IG /me returned no user_id for channel ${channel.id}; cannot backfill webhook id`,
      );
      return;
    }

    await db
      .update(socialMediaChannels)
      .set({
        metadata: sql`COALESCE(${socialMediaChannels.metadata}, '{}'::jsonb) || jsonb_build_object('igWebhookId', ${info.userId}::text)`,
      })
      .where(eq(socialMediaChannels.id, channel.id));

    // Keep the in-memory copy consistent so the same poll run resolves.
    channel.metadata = { ...(channel.metadata ?? {}), igWebhookId: info.userId };

    this.logger.log(
      `Inbox poll: backfilled igWebhookId=${info.userId} for channel ${channel.id} (platformAccountId=${channel.platformAccountId})`,
    );
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
  items:
    | { url?: string; thumbnailUrl?: string; type?: string }[]
    | null
    | undefined,
): string | undefined {
  if (!items?.length) return undefined;
  const first = items[0];
  return first.thumbnailUrl ?? first.url;
}
