import { Injectable } from '@nestjs/common';
import { getCapabilities } from '../platform-capabilities.registry';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type {
  OverviewResponseDto,
  EngagementPointDto,
} from '../dto/overview-response.dto';

export type AnalyticsRange = '7d' | '30d' | 'mtd' | 'lm' | 'custom';

@Injectable()
export class AnalyticsService {
  /**
   * Phase 1: returns shaped stub data so frontend can develop against contract.
   * Phase 2 replaces this with real queries against channel_analytics_daily +
   * post_metric_snapshots.
   */
  async getOverview(
    channelId: number,
    platform: SupportedPlatform,
    range: AnalyticsRange,
  ): Promise<OverviewResponseDto> {
    const capabilities = getCapabilities(platform);
    const days = rangeToDays(range);
    const dates = stubDates(days);

    return {
      freshness: {
        lastSyncedAt: null,
        dataFreshness: capabilities.dataFreshness,
        isPartial: true,
        trackingSinceDate: null,
        gapDays: days,
      },
      capabilities,
      summary: {
        posts: { value: 0, deltaPct: null },
        likes: { value: 0, deltaPct: null },
        comments: { value: 0, deltaPct: null },
        shares: { value: 0, deltaPct: null },
        impressions: { value: null, deltaPct: null },
        reach: { value: null, deltaPct: null },
        engagementRate: { value: null, deltaPct: null },
        followersGained: { value: null, deltaPct: null },
      },
      timeseries: {
        followers: dates.map((date) => ({ date, value: null })),
        posts: dates.map((date) => ({ date, value: 0 })),
        engagement: dates.map<EngagementPointDto>((date) => ({ date, likes: 0, comments: 0, shares: 0 })),
        reach: dates.map((date) => ({ date, value: null })),
      },
      topPosts: [],
    };
  }

  async getSyncState(_channelId: number) {
    return {
      lastSyncedAt: null,
      nextSyncAt: null,
      status: 'healthy' as const,
      consecutiveFailures: 0,
      pausedUntil: null,
      initialBackfillStatus: 'pending' as const,
    };
  }

  async requestManualRefresh(_channelId: number) {
    return { accepted: true, nextAllowedAt: null };
  }
}

function rangeToDays(range: AnalyticsRange): number {
  switch (range) {
    case '7d': return 7;
    case '30d': return 30;
    case 'mtd': return new Date().getUTCDate();
    case 'lm': return 30;
    case 'custom': return 30;
  }
}

function stubDates(days: number): string[] {
  const today = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}
