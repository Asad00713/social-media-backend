import type { FollowerRow } from '../../post-performance/followers';
import type { PeriodWindow } from '../../post-performance/period';
import {
  totalsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import { daySeries, followerTotals, type InsightsDay } from './series';

export interface ChannelBreakdown {
  channelId: number;
  postsPublished: number;
  impressions: number | null;
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
}

/**
 * One entry per channel, in the order given. `posts` and `followers` cover
 * both windows.
 */
export function channelBreakdown(
  channelIds: number[],
  posts: PublishedPost[],
  followers: FollowerRow[],
  window: PeriodWindow,
): ChannelBreakdown[] {
  return channelIds.map((channelId) => {
    const mine = posts.filter((p) => p.channelId === channelId);
    const myFollowers = followers.filter((r) => r.channelId === channelId);
    const current = mine.filter((p) => p.publishedOn >= window.from);
    const cur = totalsOf(current);
    const prev = totalsOf(mine.filter((p) => p.publishedOn < window.from));
    const f = followerTotals(myFollowers, window);

    return {
      channelId,
      postsPublished: cur.postsPublished,
      impressions: cur.impressions,
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
      series: daySeries(current, myFollowers, window.from, window.to),
    };
  });
}
