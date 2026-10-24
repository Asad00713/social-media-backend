import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, max } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { postMetricSnapshots } from '../../drizzle/schema/post-metric-snapshots.schema';
import { PostPerformanceRepository } from '../../post-performance/post-performance.repository';
import type { BestTimesDto } from '../dto/best-times.dto';
import { BestTimesCache } from '../lib/best-times-cache';
import {
  BEST_TIMES_WINDOW_DAYS,
  resolveBestTimes,
  type BestTimePost,
} from '../lib/best-times';
import { loadWorkspaceTimezone } from '../lib/workspace-time';
import { PlannerPreferencesService } from './planner-preferences.service';

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 6 * 3_600_000;
const CACHE_MAX_ENTRIES = 500;

interface SocialChannel {
  id: number;
  platform: SupportedPlatform;
}

/** What the cache keeps: each channel, with only that channel's posts. */
interface ChannelPosts extends SocialChannel {
  posts: BestTimePost[];
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Best times to post, per channel.
 *
 * The expensive part is one query for every channel's last 90 days of posts.
 * That, grouped by channel, is what the cache holds, per `(workspace, zone)`
 * for six hours. Its version is the newest metric snapshot (plus the channel
 * set), so a fresh snapshot or a connected channel invalidates it at once.
 * The maths runs on every request, after the cache: the caller's
 * `bestTimesSource` therefore never pollutes what is stored, and the 90-day
 * window always slides with `now`.
 */
@Injectable()
export class BestTimesService {
  private readonly cache = new BestTimesCache<Promise<ChannelPosts[]>>(
    CACHE_TTL_MS,
    CACHE_MAX_ENTRIES,
    () => Date.now(),
  );

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly performance: PostPerformanceRepository,
    private readonly preferences: PlannerPreferencesService,
  ) {}

  async getForWorkspace(
    workspaceId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<BestTimesDto> {
    const timezone = await loadWorkspaceTimezone(this.db, workspaceId);
    const channels = (await this.loadActiveChannels(workspaceId))
      // Social is decided by platform: the stored `category` may mislabel
      // older rows. Calendars, storage and messaging have no best time.
      .filter((c) => CHANNEL_CATEGORY[c.platform] === 'social')
      .sort((a, b) => a.id - b.id);
    if (channels.length === 0) return { timezone, channels: [] };

    const prefs = await this.preferences.get(userId, workspaceId);
    const forceGeneral = prefs.bestTimesSource === 'general';

    const ids = channels.map((c) => c.id);
    const version = `${await this.latestSnapshotMs(workspaceId, ids)}:${ids.join(',')}`;
    const key = `${workspaceId}:${timezone}`;
    // The in-flight promise is cached, so concurrent cold requests share one
    // query; a failed load is dropped so the next request retries.
    let pending = this.cache.get(key, version);
    if (!pending) {
      const load = this.loadChannelPosts(workspaceId, channels, now);
      pending = load;
      this.cache.set(key, version, load);
      load.catch(() => {
        if (this.cache.get(key, version) === load) this.cache.delete(key);
      });
    }
    const grouped = await pending;

    return {
      timezone,
      // One call per channel, with that channel's own platform and posts: the
      // 15-post gate, postCount and "x your usual" are all per channel.
      channels: grouped.map((c) => ({
        channelId: c.id,
        platform: c.platform,
        ...resolveBestTimes({
          platform: c.platform,
          posts: c.posts,
          timeZone: timezone,
          now,
          forceGeneral,
        }),
      })),
    };
  }

  private async loadChannelPosts(
    workspaceId: string,
    channels: SocialChannel[],
    now: Date,
  ): Promise<ChannelPosts[]> {
    const posts = await this.performance.publishedPosts(
      workspaceId,
      channels.map((c) => c.id),
      isoDate(now.getTime() - BEST_TIMES_WINDOW_DAYS * DAY_MS),
      isoDate(now.getTime() + DAY_MS),
    );
    const byChannel = new Map<number, BestTimePost[]>();
    for (const p of posts) {
      const list = byChannel.get(p.channelId) ?? [];
      // Keep only what the maths reads: not captions, media or permalinks.
      list.push({
        channelId: p.channelId,
        publishedAt: p.publishedAt,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        impressions: p.impressions,
      });
      byChannel.set(p.channelId, list);
    }
    return channels.map((c) => ({ ...c, posts: byChannel.get(c.id) ?? [] }));
  }

  protected async loadActiveChannels(
    workspaceId: string,
  ): Promise<SocialChannel[]> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
        ),
      );
    return rows as SocialChannel[];
  }

  /** Newest snapshot time (ms) across these channels; 0 when none yet. */
  protected async latestSnapshotMs(
    workspaceId: string,
    channelIds: number[],
  ): Promise<number> {
    // Joined to the channel so the workspace predicate is part of the query,
    // not only a property of the ids the caller happened to pass.
    const [row] = await this.db
      .select({ latest: max(postMetricSnapshots.snapshotAt) })
      .from(postMetricSnapshots)
      .innerJoin(
        socialMediaChannels,
        eq(socialMediaChannels.id, postMetricSnapshots.channelId),
      )
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          inArray(postMetricSnapshots.channelId, channelIds),
        ),
      );
    return row?.latest ? new Date(row.latest).getTime() : 0;
  }
}
