/**
 * Rule N2 (spec S7.2): a channel that has gone quiet. Shared by the period
 * brief and the next steps. Pure.
 */

import { median } from '../../post-performance/engagement-stats';
import {
  addDays,
  DAY_MS,
  isoDate,
  round1,
  utcToday,
} from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';

/** The posts a channel needs in the last 90 days to have a cadence. */
export const MIN_QUIET_POSTS = 3;
/** Quiet is never less than this many days. */
export const QUIET_MIN_DAYS = 14;
/** ... and at least this many median gaps. */
export const QUIET_GAP_FACTOR = 2;
/** The sample the cadence is read from. */
export const QUIET_LOOKBACK_DAYS = 90;

export interface QuietChannel {
  channelId: number;
  /** UTC day of the newest post, `YYYY-MM-DD`. */
  lastPostOn: string;
  daysQuiet: number;
  /** Median days between the channel's posting days, one decimal. */
  medianGapDays: number;
  /** `almost daily`, `weekly`, `every two weeks` or `about monthly`. */
  cadence: string;
}

export interface QuietInput {
  channelId: number;
  /** The channel's published posts in the last 90 days. */
  posts: PublishedPost[];
  isActive: boolean;
  /** Connected and syncing: a broken connection is a different problem. */
  healthy: boolean;
  today: Date;
}

const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** How often the channel posted, from its median gap in days. */
export function cadenceOf(medianGapDays: number): string {
  if (medianGapDays <= 2) return 'almost daily';
  if (medianGapDays <= 9) return 'weekly';
  if (medianGapDays <= 16) return 'every two weeks';
  return 'about monthly';
}

/**
 * The most overdue quiet channel, or null. Quiet: active, healthy, at least
 * MIN_QUIET_POSTS posts in the lookback on at least two different days, and
 * as many days since the last post as max(14, 2 x its median gap). Most
 * overdue is the most days past that threshold; then the longer quiet, then
 * the lower id.
 */
export function quietChannel(inputs: QuietInput[]): QuietChannel | null {
  let best: (QuietChannel & { overdue: number }) | null = null;
  for (const c of inputs) {
    if (!c.isActive || !c.healthy) continue;
    const todayIso = isoDate(utcToday(c.today));
    const from = addDays(todayIso, -QUIET_LOOKBACK_DAYS);
    const posts = c.posts.filter(
      (p) => p.publishedOn >= from && p.publishedOn <= todayIso,
    );
    if (posts.length < MIN_QUIET_POSTS) continue;
    // Posting days, not posts: three posts in one afternoon are no cadence.
    const dates = [...new Set(posts.map((p) => p.publishedOn))].sort();
    if (dates.length < 2) continue;
    const gaps = dates
      .slice(1)
      .map((d, i) => Math.round((dayMs(d) - dayMs(dates[i])) / DAY_MS));
    const gap = median(gaps)!;
    const lastPostOn = dates[dates.length - 1];
    const daysQuiet = Math.round(
      (dayMs(todayIso) - dayMs(lastPostOn)) / DAY_MS,
    );
    const threshold = Math.max(QUIET_MIN_DAYS, QUIET_GAP_FACTOR * gap);
    if (daysQuiet < threshold) continue;
    const overdue = daysQuiet - threshold;
    if (
      !best ||
      overdue > best.overdue ||
      (overdue === best.overdue &&
        (daysQuiet > best.daysQuiet ||
          (daysQuiet === best.daysQuiet && c.channelId < best.channelId)))
    ) {
      best = {
        channelId: c.channelId,
        lastPostOn,
        daysQuiet,
        medianGapDays: round1(gap),
        cadence: cadenceOf(gap),
        overdue,
      };
    }
  }
  if (!best) return null;
  return {
    channelId: best.channelId,
    lastPostOn: best.lastPostOn,
    daysQuiet: best.daysQuiet,
    medianGapDays: best.medianGapDays,
    cadence: best.cadence,
  };
}
