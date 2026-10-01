/**
 * How published posts performed: every post a channel published, counted
 * once, with its latest reported numbers. The one definition Home and
 * Insights share, so the two never disagree.
 *
 * Deliberately not `channel_analytics_daily`. Each of its rows sums the
 * *lifetime* counts of every post snapshotted that day, and a young post is
 * snapshotted daily, so adding its rows up counts the same likes once per day
 * (about 30× over a month). Its `posts_published` is "posts snapshotted that
 * day", not published. Only its follower columns are day-by-day values.
 *
 * Pure: the repository fetches, these functions count.
 */

import { round1 } from './period';

/** A media item as stored on the post. Imported posts call every item `image`. */
export interface PostMediaItem {
  url: string;
  type: string;
  thumbnailUrl?: string | null;
}

/** One post on one channel. A post sent to two channels is two of these. */
export interface PublishedPost {
  postId: string;
  channelId: number;
  /** UTC day it went out, `YYYY-MM-DD`. */
  publishedOn: string;
  /** Latest reported counts; null until the platform has reported one. */
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  /** When it went out, ISO 8601. */
  publishedAt: string;
  /** The whole caption; '' when there is none. Insights trims it for cards. */
  content: string;
  mediaItems: PostMediaItem[];
  /** Imported from the platform rather than composed in Schedura. */
  imported: boolean;
  /** The post on the platform, when the target recorded it. */
  permalink: string | null;
  /**
   * `platform_metrics.mediaType` from the newest snapshot that has one
   * (Instagram, Threads, X).
   */
  mediaType: string | null;
}

export interface PostTotals {
  postsPublished: number;
  /** null when no post's platform reported impressions. */
  impressions: number | null;
  engagements: number;
  /**
   * Engagements ÷ impressions × 100, one decimal, over only the posts whose
   * platform reports impressions; null when none does.
   */
  engagementRate: number | null;
}

/** Likes, comments and shares; an unreported count adds nothing. */
export function engagementsOf(p: PublishedPost): number {
  return (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0);
}

export function totalsOf(posts: PublishedPost[]): PostTotals {
  let engagements = 0;
  let impressions: number | null = null;
  // Engagements on posts that also report impressions: the rate's numerator.
  let ratedEngagements = 0;

  for (const p of posts) {
    const e = engagementsOf(p);
    engagements += e;
    if (p.impressions !== null) {
      impressions = (impressions ?? 0) + p.impressions;
      ratedEngagements += e;
    }
  }

  return {
    postsPublished: posts.length,
    impressions,
    engagements,
    engagementRate: impressions
      ? round1((ratedEngagements / impressions) * 100)
      : null,
  };
}
