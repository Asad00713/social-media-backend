import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { inArray } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { decrypt } from '../../common/utils/encryption.util';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  channelAudience,
  type ChannelAudienceRow,
} from '../../drizzle/schema/channel-audience.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { YouTubeAnalyticsApiClient } from '../../channels/analytics/adapters/youtube/youtube-analytics-api.client';
import { getCapabilities } from '../../channels/analytics/platform-capabilities.registry';
import { REDIS_CLIENT } from '../../channels/analytics/redis-client.provider';
import { addDays } from '../../post-performance/period';
import { QUEUES } from '../../queue/queue.module';
import {
  InsightsChannelsRepository,
  type SocialChannel,
} from '../insights-channels.repository';
import { parseChannels, type ResolvedPeriod } from '../lib/query';
import type {
  AudienceChannelDto,
  AudienceChannelsDto,
  AudienceGrowthDto,
  AudienceSlice,
} from './audience.dto';
import { audienceCsv } from './audience-csv';
import { audienceGrowth } from './growth';
import { latestFollowerCounts } from './latest-followers';
import { toShares, youtubeAges, youtubeGenders } from './normalize';

/** Platforms whose breakdown comes from the stored `channel_audience` row. */
const STORED_PLATFORMS: readonly string[] = [
  'instagram',
  'threads',
  'facebook',
];

/** A stored row older than this is shown as is and refreshed in the background. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** YouTube's live breakdown is cached for 12 hours per channel and window. */
export const YOUTUBE_CACHE_TTL_SECONDS = 43_200;

export const AUDIENCE_REFRESH_JOB = 'channel-audience-refresh';

/** The slice of ioredis this service uses; a fake satisfies it in specs. */
export interface AudienceCache {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<unknown>;
}

interface YoutubeAudience {
  countries: AudienceSlice[];
  ages: AudienceSlice[];
  genders: AudienceSlice[];
  fetchedAt: string;
}

const EMPTY: Pick<
  AudienceChannelDto,
  'countries' | 'cities' | 'ages' | 'genders'
> = { countries: [], cities: [], ages: [], genders: [] };

/**
 * What the Insights Audience tab reads: follower growth from the daily
 * rollup, and the demographic breakdown per channel. No LLM anywhere in here.
 */
@Injectable()
export class AudienceService {
  private readonly logger = new Logger(AudienceService.name);

  constructor(
    private readonly channelsRepo: InsightsChannelsRepository,
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly youtube: YouTubeAnalyticsApiClient,
    @Inject(REDIS_CLIENT) private readonly redis: AudienceCache,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
  ) {}

  /** The workspace's social channels narrowed by the `channels` param. */
  private async filtered(
    workspaceId: string,
    channels: string | undefined,
  ): Promise<SocialChannel[]> {
    const social = await this.channelsRepo.socialChannels(workspaceId);
    const wanted = new Set(
      parseChannels(
        channels,
        social.map((c) => c.id),
      ),
    );
    return social.filter((c) => wanted.has(c.id));
  }

  async growth(
    workspaceId: string,
    { window }: ResolvedPeriod,
    channels: string | undefined,
  ): Promise<AudienceGrowthDto> {
    const kept = (await this.filtered(workspaceId, channels)).filter(
      (c) => getCapabilities(c.platform).hasFollowerCount,
    );
    const rows = await this.channelsRepo.followerRows(
      kept.map((c) => c.id),
      window.from,
      addDays(window.to, 1),
    );
    return audienceGrowth(rows, kept, window);
  }

  async csv(
    workspaceId: string,
    period: ResolvedPeriod,
    channels: string | undefined,
  ): Promise<{ filename: string; body: string }> {
    const growth = await this.growth(workspaceId, period, channels);
    return {
      filename: `schedura-audience-${growth.window.from}-${growth.window.to}.csv`,
      body: audienceCsv(growth),
    };
  }

  async channels(
    workspaceId: string,
    { window }: ResolvedPeriod,
    channels: string | undefined,
    now = new Date(),
  ): Promise<AudienceChannelsDto> {
    const kept = await this.filtered(workspaceId, channels);
    const ids = kept.map((c) => c.id);
    const storedIds = kept
      .filter((c) => STORED_PLATFORMS.includes(c.platform))
      .map((c) => c.id);
    const youtubeChannels = kept.filter((c) => c.platform === 'youtube');

    const [followers, stored, live] = await Promise.all([
      latestFollowerCounts(this.db, ids),
      this.storedRows(storedIds),
      this.youtubeAudiences(youtubeChannels, window, now),
    ]);

    const out = kept.map((c): AudienceChannelDto => {
      const base = {
        channelId: c.id,
        platform: c.platform,
        name: c.accountName,
        followerCount: followers.get(c.id) ?? null,
      };

      if (STORED_PLATFORMS.includes(c.platform)) {
        const row = stored.get(c.id);
        const isStale =
          !row || now.getTime() - row.fetchedAt.getTime() > STALE_AFTER_MS;
        if (isStale) this.enqueueRefresh(c.id, now);
        if (!row) {
          // Connected recently, not fetched yet: "couldn't load" would be false.
          return {
            ...base,
            status: 'pending',
            reconnectable: false,
            fetchedAt: null,
            measure: 'followers',
            ...EMPTY,
          };
        }
        return {
          ...base,
          status: row.status,
          reconnectable:
            c.platform === 'facebook' &&
            row.status === 'no_permission' &&
            process.env.FACEBOOK_REQUEST_READ_INSIGHTS === 'true',
          fetchedAt: row.fetchedAt.toISOString(),
          measure: 'followers',
          countries: toShares(row.countries, 'countries'),
          cities: toShares(row.cities, 'cities'),
          ages: toShares(row.ages, 'ages'),
          genders: toShares(row.genders, 'genders'),
        };
      }

      if (c.platform === 'youtube') {
        const audience = live.get(c.id);
        return {
          ...base,
          status: audience ? 'ok' : 'failed',
          reconnectable: false,
          fetchedAt: audience?.fetchedAt ?? null,
          measure: 'viewers',
          countries: audience?.countries ?? [],
          cities: [],
          ages: audience?.ages ?? [],
          genders: audience?.genders ?? [],
        };
      }

      return {
        ...base,
        status: 'unsupported',
        reconnectable: false,
        fetchedAt: null,
        measure: 'followers',
        ...EMPTY,
      };
    });
    return { channels: out };
  }

  private async storedRows(
    channelIds: number[],
  ): Promise<Map<number, ChannelAudienceRow>> {
    if (channelIds.length === 0) return new Map();
    const rows = (await this.db
      .select()
      .from(channelAudience)
      .where(
        inArray(channelAudience.channelId, channelIds),
      )) as ChannelAudienceRow[];
    return new Map(rows.map((r) => [r.channelId, r]));
  }

  /**
   * Fires the same job, with the same id, as the daily cron, so a stale read
   * and the cron dedupe. Never awaited and never throws: a queue outage must
   * not fail the read.
   */
  private enqueueRefresh(channelId: number, now: Date): void {
    const day = now.toISOString().slice(0, 10);
    const log = (err: unknown) =>
      this.logger.warn(
        `Could not enqueue audience refresh for channel ${channelId}: ${(err as Error).message}`,
      );
    try {
      void this.queue
        .add(
          AUDIENCE_REFRESH_JOB,
          { channelId },
          { jobId: `audience-${channelId}-${day}` },
        )
        .catch(log);
    } catch (err) {
      log(err);
    }
  }

  /**
   * Live YouTube viewer breakdowns, cached per channel and window. A channel
   * missing from the result failed; failures are never cached.
   */
  private async youtubeAudiences(
    channels: SocialChannel[],
    window: { from: string; to: string },
    now: Date,
  ): Promise<Map<number, YoutubeAudience>> {
    const out = new Map<number, YoutubeAudience>();
    if (channels.length === 0) return out;

    const misses: SocialChannel[] = [];
    await Promise.all(
      channels.map(async (c) => {
        const hit = await this.cacheRead(cacheKey(c.id, window));
        if (hit) out.set(c.id, hit);
        else misses.push(c);
      }),
    );
    if (misses.length === 0) return out;

    let tokens: Map<number, string>;
    try {
      const rows = (await this.db
        .select({
          id: socialMediaChannels.id,
          accessToken: socialMediaChannels.accessToken,
        })
        .from(socialMediaChannels)
        .where(
          inArray(
            socialMediaChannels.id,
            misses.map((c) => c.id),
          ),
        )) as Array<{ id: number; accessToken: string }>;
      tokens = new Map(rows.map((r) => [r.id, r.accessToken]));
    } catch (err) {
      this.logger.warn(
        `YouTube audience: token lookup failed: ${(err as Error).message}`,
      );
      return out;
    }

    await Promise.all(
      misses.map(async (c) => {
        try {
          const stored = tokens.get(c.id);
          if (!stored) throw new Error('channel has no access token');
          const opts = {
            accessToken: decrypt(stored),
            startDate: window.from,
            endDate: window.to,
          };
          const [demographics, countries] = await Promise.all([
            this.youtube.getDemographics(opts),
            this.youtube.getViewsByCountry(opts),
          ]);
          const audience: YoutubeAudience = {
            countries: toShares(countries, 'countries'),
            ages: toShares(youtubeAges(demographics), 'ages', true),
            genders: toShares(youtubeGenders(demographics), 'genders', true),
            fetchedAt: now.toISOString(),
          };
          out.set(c.id, audience);
          await this.cacheWrite(cacheKey(c.id, window), audience);
        } catch (err) {
          this.logger.warn(
            `YouTube audience failed for channel ${c.id}: ${(err as Error).message}`,
          );
        }
      }),
    );
    return out;
  }

  private async cacheRead(key: string): Promise<YoutubeAudience | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as YoutubeAudience) : null;
    } catch (err) {
      this.logger.warn(`Audience cache read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async cacheWrite(
    key: string,
    audience: YoutubeAudience,
  ): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(audience),
        'EX',
        YOUTUBE_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `Audience cache write failed: ${(err as Error).message}`,
      );
    }
  }
}

/** Includes the window: a 7-day view must not be served 90-day numbers. */
export function cacheKey(
  channelId: number,
  window: { from: string; to: string },
): string {
  return `audience:yt:${channelId}:${window.from}:${window.to}`;
}
