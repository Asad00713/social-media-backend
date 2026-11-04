/**
 * Gathers the brief's inputs from what the overview already holds, then asks
 * `buildBrief` for the sentences. Pure; the service passes in what it read.
 */

import type { FollowerRow } from '../../post-performance/followers';
import {
  addDays,
  deltaPct,
  isoDate,
  isPeriodDays,
  type MetricChange,
  type PeriodWindow,
  spanDays,
  utcToday,
} from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import {
  buildBrief,
  type Brief,
  type BriefInput,
  type BriefQuiet,
} from './brief';
import type { ChannelFreshness } from './freshness';
import type { InsightPost } from './insight-post';
import type { CompareMode } from './query';
import { quietChannel } from './quiet-channel';
import { daySeries, rangeTotals } from './series';
import type { Standout } from './standout';
import { lookbackStartOf, usualOf } from './usual';

/** Days before the last post the "followers were growing" rate reads. */
export const FOLLOWER_PRIOR_DAYS = 28;

/** The channel facts the brief names. */
export interface BriefChannel {
  id: number;
  /** Display name of the platform, `Instagram`. */
  platformName: string;
  accountName: string;
  isActive: boolean;
  connectionStatus: string;
}

export interface BriefContext {
  days: number;
  window: PeriodWindow;
  compare: CompareMode;
  now: Date;
  channels: BriefChannel[];
  freshness: ChannelFreshness[];
  /** The usual's lookback through the window's last day. */
  published: PublishedPost[];
  /** The last 90 days through today, on the selected channels. */
  sample: PublishedPost[];
  followers: FollowerRow[];
  /** The window's posts. */
  posts: InsightPost[];
  standout: Standout & { aboveAll: InsightPost[] };
  impressions: MetricChange;
  engagements: MetricChange;
}

/**
 * What the followers of a quiet channel did, from the rollup rows we hold.
 * Null unless the rows reach yesterday (a picked range that ended earlier
 * can't say what happened since) and the channel reported followers on both
 * sides of its last post.
 */
export function quietFollowers(
  rows: FollowerRow[],
  channelId: number,
  lastPostOn: string,
  yesterday: string,
  windowTo: string,
): BriefQuiet['followers'] {
  if (windowTo < yesterday) return null;
  const mine = rows.filter((r) => r.channelId === channelId);
  const counted = mine
    .filter((r) => r.followersAtEndOfDay !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!counted.length) return null;

  const since = mine.filter(
    (r) => r.date > lastPostOn && r.followersGained !== null,
  );
  const priorFrom = addDays(lastPostOn, -FOLLOWER_PRIOR_DAYS);
  const prior = mine.filter(
    (r) =>
      r.date > priorFrom && r.date <= lastPostOn && r.followersGained !== null,
  );
  if (!since.length || !prior.length) return null;
  const sum = (rs: FollowerRow[]) =>
    rs.reduce((a, r) => a + (r.followersGained ?? 0), 0);
  return {
    count: counted[0].followersAtEndOfDay!,
    gainedSince: sum(since),
    // Over the days that reported, so a short history isn't read as slow.
    priorPerDay: sum(prior) / new Set(prior.map((r) => r.date)).size,
  };
}

/** Each posting channel's engagements against its own usual. */
export function channelEngagementDeltas(
  channelIds: number[],
  published: PublishedPost[],
  window: PeriodWindow,
): BriefInput['channelDeltas'] {
  const n = spanDays(window.from, window.to);
  const start = lookbackStartOf(window.from, n);
  return channelIds.map((channelId) => {
    const mine = published.filter(
      (p) => p.channelId === channelId && p.publishedOn <= window.to,
    );
    const days = daySeries(mine, [], start, window.to);
    const cur = rangeTotals(days.filter((d) => d.date >= window.from));
    const usual = usualOf(days, mine, 'engagements', n, window.from);
    return {
      channelId,
      posts: cur.postsPublished,
      deltaPct: cur.postsPublished
        ? deltaPct(cur.engagements, usual?.median ?? null)
        : null,
    };
  });
}

/** This period in brief, from the overview's own parts. */
export function periodBrief(ctx: BriefContext): Brief {
  const { window, days, now } = ctx;
  const yesterday = addDays(isoDate(utcToday(now)), -1);
  const postingIds = [...new Set(ctx.posts.map((p) => p.channelId))];
  const reportsViews = ctx.freshness.some((f) => f.reportsViews);
  const onViews = reportsViews && ctx.impressions.value !== null;
  const byId = new Map(ctx.channels.map((c) => [c.id, c]));
  const healthy = new Map(
    ctx.freshness.map((f) => [
      f.channelId,
      f.connectionStatus === 'connected' && !f.failing,
    ]),
  );

  // A past picked range can't say who is quiet now (like quietFollowers).
  const quiet =
    window.to < yesterday
      ? null
      : quietChannel(
          ctx.channels.map((c) => ({
            channelId: c.id,
            posts: ctx.sample.filter((p) => p.channelId === c.id),
            isActive: c.isActive,
            healthy: healthy.get(c.id) ?? false,
            today: now,
          })),
        );

  return buildBrief({
    days,
    rangeKind: rangeKindOf(days, window.to, yesterday),
    compare: ctx.compare,
    postsCount: ctx.posts.length,
    channelsCount: postingIds.length,
    headline: onViews
      ? {
          label: 'Views',
          value: ctx.impressions.value!,
          deltaPct: ctx.impressions.deltaPct,
        }
      : {
          label: 'Engagement',
          value: ctx.engagements.value ?? 0,
          deltaPct: ctx.engagements.deltaPct,
        },
    engagements: {
      value: ctx.engagements.value ?? 0,
      deltaPct: ctx.engagements.deltaPct,
    },
    above: ctx.standout.aboveAll,
    channelDeltas: channelEngagementDeltas(postingIds, ctx.published, window),
    quiet: quiet
      ? {
          ...quiet,
          followers: quietFollowers(
            ctx.followers,
            quiet.channelId,
            quiet.lastPostOn,
            yesterday,
            window.to,
          ),
        }
      : null,
    channels: Object.fromEntries(
      [...byId].map(([id, c]) => [
        id,
        { platform: proseName(c.platformName), name: c.accountName },
      ]),
    ),
  });
}

/** `X (Twitter)` reads `X` in a sentence: the label without its parentheses. */
export function proseName(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '');
}

/** A preset is 7, 30 or 90 days ending yesterday; anything else is picked. */
export function rangeKindOf(
  days: number,
  windowTo: string,
  yesterday: string,
): 'preset' | 'custom' {
  return isPeriodDays(days) && windowTo === yesterday ? 'preset' : 'custom';
}
