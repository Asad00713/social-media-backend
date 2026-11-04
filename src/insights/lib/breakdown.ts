import type { FollowerRow } from '../../post-performance/followers';
import {
  deltaPct,
  spanDays,
  type PeriodWindow,
} from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import {
  daySeries,
  followerTotals,
  rangeTotals,
  type InsightsDay,
} from './series';
import { lookbackStartOf, toneOf, usualOf } from './usual';

/** A channel's window against its own usual, whatever Compare says. */
export interface ChannelVsUsual {
  /** Views when the channel reports them, else engagements. */
  metric: 'impressions' | 'engagements';
  /** % against the channel's usual; null without a usual or a value. */
  deltaPct: number | null;
  tone: 'up' | 'flat' | 'down' | null;
}

export interface ChannelBreakdown {
  channelId: number;
  postsPublished: number;
  impressions: number | null;
  /** null when no post in the window reported reach. */
  reach: number | null;
  engagements: number;
  engagementRate: number | null;
  followers: number | null;
  followersGained: number | null;
  previous: {
    postsPublished: number;
    impressions: number | null;
    engagements: number;
    followersGained: number | null;
  };
  series: InsightsDay[];
  vsUsual: ChannelVsUsual;
}

export interface BreakdownChannel {
  channelId: number;
  /** The platform says it shares views (`PLATFORM_CAPABILITIES`). */
  reportsViews: boolean;
  /** False when paused by hand or locked by the plan. */
  isActive: boolean;
}

/**
 * One entry per channel, in the order given. `posts` and `followers` cover
 * the usual's lookback through the window's last day; each part reads only
 * its own dates. "vs. your usual" is on views when the platform shares them
 * and some arrived (a platform can share them in principle and send none,
 * e.g. before Meta's App Review), else on engagements. A paused channel
 * with no post in the window has no delta.
 */
export function channelBreakdown(
  channels: BreakdownChannel[],
  posts: PublishedPost[],
  followers: FollowerRow[],
  window: PeriodWindow,
): ChannelBreakdown[] {
  const n = spanDays(window.from, window.to);
  const start = lookbackStartOf(window.from, n);
  return channels.map(({ channelId, reportsViews, isActive }) => {
    const mine = posts.filter(
      (p) =>
        p.channelId === channelId &&
        p.publishedOn >= start &&
        p.publishedOn <= window.to,
    );
    const myFollowers = followers.filter((r) => r.channelId === channelId);
    const days = daySeries(mine, myFollowers, start, window.to);
    const series = days.filter((d) => d.date >= window.from);
    const cur = rangeTotals(series);
    const prev = rangeTotals(
      days.filter(
        (d) => d.date >= window.previousFrom && d.date <= window.previousTo,
      ),
    );
    const f = followerTotals(myFollowers, window);

    const metric =
      reportsViews && mine.some((p) => p.impressions !== null)
        ? 'impressions'
        : 'engagements';
    // A paused channel with nothing in the window stopped counting: its
    // numbers are missing, not zero, so there is no "-100% vs usual" (Q4).
    const stopped = !isActive && cur.postsPublished === 0;
    const usual = stopped ? null : usualOf(days, mine, metric, n, window.from);
    const delta = deltaPct(cur[metric], usual?.median ?? null);

    return {
      channelId,
      postsPublished: cur.postsPublished,
      impressions: cur.impressions,
      reach: cur.reach,
      engagements: cur.engagements,
      engagementRate: cur.engagementRate,
      followers: f.value,
      followersGained: f.gained,
      previous: {
        postsPublished: prev.postsPublished,
        impressions: prev.impressions,
        engagements: prev.engagements,
        followersGained: f.previousGained,
      },
      series,
      vsUsual: { metric, deltaPct: delta, tone: toneOf(delta) },
    };
  });
}
