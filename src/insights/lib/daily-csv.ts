import { round1 } from '../../post-performance/period';
import { csvCell } from './content-table';
import type { InsightsDay } from './series';

export const DAILY_CSV_HEADER = [
  'date',
  'posts',
  'impressions',
  'reach',
  'engagements',
  'engagement_rate',
  'likes',
  'comments',
  'shares',
  'followers',
  'followers_gained',
];

/**
 * The day's engagement rate in percent, one decimal: engagements on posts
 * that report impressions over those impressions (the Insights definition).
 * Null on a day without impressions.
 */
export function dayEngagementRate(d: InsightsDay): number | null {
  return d.impressions
    ? round1((d.ratedEngagements / d.impressions) * 100)
    : null;
}

/**
 * `GET /insights/.../export?kind=daily`: one row per day of the window,
 * oldest first. A metric nothing reported is an empty cell, never 0. Same
 * BOM and line endings as the posts CSV, so Excel reads it as UTF-8.
 */
export function dailyCsv(days: InsightsDay[]): string {
  const lines = [DAILY_CSV_HEADER.join(',')];
  for (const d of days) {
    lines.push(
      [
        d.date,
        d.postsPublished,
        d.impressions,
        d.reach,
        d.engagements,
        dayEngagementRate(d),
        d.likes,
        d.comments,
        d.shares,
        d.followers,
        d.followersGained,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
