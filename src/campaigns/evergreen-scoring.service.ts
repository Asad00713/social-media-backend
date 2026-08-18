import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { campaigns } from '../drizzle/schema/campaigns.schema';
import {
  evergreenCategories,
  evergreenOccurrences,
  evergreenPosts,
  type EvergreenPost,
} from '../drizzle/schema/evergreen.schema';
import { postMetricSnapshots } from '../drizzle/schema/post-metric-snapshots.schema';
import { GroqService } from '../ai/groq.service';
import { AiTokenService } from '../ai/services/ai-token.service';

/**
 * D2 (performance-aware scoring) + D3 (freshness guard) for evergreen pool
 * posts. Deliberately a SEPARATE service from `EvergreenService` — scoring
 * is a background/on-demand concern, never on the fire hot-path
 * (`fireOccurrence`/`armCategory` never call into this file).
 */
@Injectable()
export class EvergreenScoringService {
  private readonly logger = new Logger(EvergreenScoringService.name);

  constructor(
    private readonly groq: GroqService,
    private readonly aiTokens: AiTokenService,
  ) {}

  // ========================================================================
  // D2 — performance-aware scoring
  // ========================================================================

  /**
   * Recomputes `performanceScore` for every ACTIVE pool post in a campaign.
   *
   * For each post: gathers its `evergreenOccurrences` rows, collects their
   * `postsRowId`s (the materialized `posts.id` each occurrence published
   * to), reads the LATEST `post_metric_snapshots` row per `postsRowId`
   * (mirrors `analytics.service.ts`'s "latest snapshot per post" basis —
   * summing across snapshots would double-count since snapshots accumulate
   * cumulative metrics over time), and sums `likesCount + commentsCount +
   * sharesCount` per snapshot, then across the post's snapshots, as the
   * post's total engagement.
   *
   * Engagement is then min-max normalized to [0,1] across the campaign's
   * scored pool (0 = lowest-engagement post in the pool, 1 = highest).
   * Posts with NO snapshots (never fired yet, or fired but no metrics
   * synced) are left at `performanceScore = null` — unscored is neutral,
   * never 0, since a 0 would wrongly sink an untested post to the bottom
   * of the rotation picker before it ever got a fair shot.
   *
   * Never throws on an empty snapshot set (e.g. a brand-new campaign with
   * no published occurrences yet) — it simply leaves every post's score at
   * `null` and returns.
   */
  async recomputeScores(campaignId: string): Promise<void> {
    const categoryRows = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.campaignId, campaignId));

    const categoryIds = categoryRows.map((c) => c.id);
    if (categoryIds.length === 0) {
      this.logger.log(
        `recomputeScores(${campaignId}): no categories — nothing to score.`,
      );
      return;
    }

    const allPostRows = await db
      .select()
      .from(evergreenPosts)
      .where(eq(evergreenPosts.campaignId, campaignId));

    const activePosts = allPostRows.filter((p) => p.status === 'active');
    if (activePosts.length === 0) {
      this.logger.log(
        `recomputeScores(${campaignId}): no active pool posts — nothing to score.`,
      );
      return;
    }

    const occurrenceRows = await db
      .select()
      .from(evergreenOccurrences)
      .where(eq(evergreenOccurrences.campaignId, campaignId));

    // postId (evergreenPosts.id) -> Set of materialized posts.id rows it has
    // ever published to.
    const postsRowIdsByPost = new Map<string, Set<string>>();
    for (const occ of occurrenceRows) {
      if (!occ.postsRowId) continue;
      const set = postsRowIdsByPost.get(occ.postIdRef) ?? new Set<string>();
      set.add(occ.postsRowId);
      postsRowIdsByPost.set(occ.postIdRef, set);
    }

    const allPostsRowIds = Array.from(
      new Set(occurrenceRows.map((o) => o.postsRowId).filter((v): v is string => !!v)),
    );

    const snapshotRows =
      allPostsRowIds.length > 0
        ? await db
            .select()
            .from(postMetricSnapshots)
            .where(inArray(postMetricSnapshots.postId, allPostsRowIds))
        : [];

    // Latest snapshot per posts-row-id.
    const latestSnapshotByPostsRowId = new Map<
      string,
      (typeof snapshotRows)[number]
    >();
    for (const snap of snapshotRows) {
      const existing = latestSnapshotByPostsRowId.get(snap.postId);
      if (!existing || snap.snapshotAt.getTime() > existing.snapshotAt.getTime()) {
        latestSnapshotByPostsRowId.set(snap.postId, snap);
      }
    }

    // Total engagement per evergreen pool post (sum of its posts-rows'
    // latest-snapshot engagement — a post recycled across multiple channels
    // accumulates one posts-row per fire, so this sums across all of them).
    const engagementByPostId = new Map<string, number>();
    for (const post of activePosts) {
      const postsRowIds = postsRowIdsByPost.get(post.id);
      if (!postsRowIds || postsRowIds.size === 0) continue;

      let total = 0;
      let hasAnySnapshot = false;
      for (const postsRowId of postsRowIds) {
        const snap = latestSnapshotByPostsRowId.get(postsRowId);
        if (!snap) continue;
        hasAnySnapshot = true;
        total +=
          (snap.likesCount ?? 0) +
          (snap.commentsCount ?? 0) +
          (snap.sharesCount ?? 0);
      }
      if (hasAnySnapshot) {
        engagementByPostId.set(post.id, total);
      }
    }

    if (engagementByPostId.size === 0) {
      this.logger.log(
        `recomputeScores(${campaignId}): no posts have any metric snapshots yet — leaving all scores null.`,
      );
      return;
    }

    const engagementValues = Array.from(engagementByPostId.values());
    const min = Math.min(...engagementValues);
    const max = Math.max(...engagementValues);
    const range = max - min;

    const now = new Date();
    for (const post of activePosts) {
      const engagement = engagementByPostId.get(post.id);
      if (engagement === undefined) {
        // No snapshots — leave null (only write if it wasn't already null,
        // to avoid needless churn — but a plain unconditional write is also
        // safe; keep it simple and always write for now-null convergence).
        if (post.performanceScore !== null) {
          await db
            .update(evergreenPosts)
            .set({ performanceScore: null, updatedAt: now })
            .where(eq(evergreenPosts.id, post.id));
        }
        continue;
      }

      // min-max normalize; a pool where every scored post has identical
      // engagement (range === 0) scores everyone at 1 (all equally "best"
      // among the scored set) rather than dividing by zero.
      const score = range === 0 ? 1 : (engagement - min) / range;

      await db
        .update(evergreenPosts)
        .set({ performanceScore: score, updatedAt: now })
        .where(eq(evergreenPosts.id, post.id));
    }
  }

  /**
   * Weekly sweep: recomputes scores for every campaign that has evergreen
   * content and is currently active. Fires Sunday 04:00 UTC — after the
   * daily 03:00 UTC ad-insights/reconcile crons, deliberately off the
   * publish hot-path.
   */
  @Cron('0 4 * * 0', { timeZone: 'UTC', name: 'evergreenScoring' })
  async recomputeAllActiveScores(): Promise<void> {
    const activeCampaigns = (await db.select().from(campaigns)).filter(
      (c) => c.type === 'evergreen' && c.status === 'active',
    );

    if (activeCampaigns.length === 0) {
      this.logger.verbose('evergreenScoring: no active evergreen campaigns');
      return;
    }

    this.logger.log(
      `evergreenScoring: recomputing scores for ${activeCampaigns.length} campaign(s)`,
    );

    for (const campaign of activeCampaigns) {
      try {
        await this.recomputeScores(campaign.id);
      } catch (error) {
        this.logger.error(
          `evergreenScoring: failed to recompute scores for campaign ${campaign.id}: ${error}`,
        );
      }
    }
  }

  // ========================================================================
  // D3 — freshness guard
  // ========================================================================

  private async loadOwnedPost(
    categoryId: string,
    postId: string,
  ): Promise<EvergreenPost | undefined> {
    const [existing] = await db
      .select()
      .from(evergreenPosts)
      .where(eq(evergreenPosts.id, postId));
    if (!existing || existing.categoryId !== categoryId) {
      return undefined;
    }
    return existing;
  }

  /** Scopes a campaign id to its workspace, 404ing otherwise. Mirrors
   *  `EvergreenService.loadOwnedCampaign` — every other evergreen mutation
   *  binds `campaignId` to `workspaceId` this way before touching
   *  category/post rows; `checkFreshness` must too, since it accepts
   *  `campaignId` directly from the route and otherwise never verifies it
   *  belongs to the caller's workspace (IDOR). */
  private async loadOwnedCampaign(
    workspaceId: string,
    campaignId: string,
  ): Promise<void> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)),
      );
    if (!row) {
      throw new NotFoundException('Campaign not found');
    }
  }

  /**
   * Runs a cheap Groq staleness check against a pool post's base caption
   * and writes the verdict onto `isStale`/`staleReason`.
   *
   * GRACEFUL DEGRADATION: if Groq (or `AiTokenService.executeWithTokens`
   * wrapping it — insufficient tokens, no active subscription, etc.) throws
   * for ANY reason, this returns `{ isStale: false, reason: null }` and
   * does NOT write to the post at all. A freshness check must never block
   * the caller or false-flag a perfectly fine post just because the AI
   * provider had a bad moment.
   */
  async checkFreshness(
    workspaceId: string,
    userId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
  ): Promise<{ isStale: boolean; reason: string | null }> {
    // IDOR guard (M2): bind campaignId to workspaceId BEFORE touching
    // anything else, and before the graceful-degrade try/catch below —
    // an unowned campaign must 404, not silently no-op.
    await this.loadOwnedCampaign(workspaceId, campaignId);

    const post = await this.loadOwnedPost(categoryId, postId);
    if (!post || post.campaignId !== campaignId) {
      return { isStale: false, reason: null };
    }

    const caption = post.content.caption;

    try {
      const { result: verdict } = await this.aiTokens.executeWithTokens(
        workspaceId,
        userId,
        'freshness_check',
        undefined,
        `Freshness check: ${caption.substring(0, 100)}`,
        async () => {
          const result = await this.groq.checkFreshness(caption);
          return { result, outputLength: (result.reason ?? '').length };
        },
      );

      await db
        .update(evergreenPosts)
        .set({
          isStale: verdict.isStale,
          staleReason: verdict.reason,
          updatedAt: new Date(),
        })
        .where(eq(evergreenPosts.id, postId));

      return verdict;
    } catch (error) {
      this.logger.warn(
        `checkFreshness(${postId}): Groq/token check failed, treating as not-stale (graceful): ${error}`,
      );
      return { isStale: false, reason: null };
    }
  }
}
