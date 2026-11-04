/**
 * The words of the three next steps (spec S7.2). Kept apart from the rules in
 * `next-steps.ts` so a copy change never touches a threshold. Pure.
 */

import type { FollowerRow } from '../../post-performance/followers';
import { formatCompact, PLURAL, shortDate, SINGULAR } from './brief';
import type { PostFormat } from './insight-post';

const capitalise = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `October` from `2026-10-03`, by the UTC date. */
const monthName = (iso: string): string =>
  MONTHS[Number(iso.split('-')[1]) - 1];

/**
 * Where the format gap was measured: the platforms by name when there are one
 * or two, otherwise `your channels`.
 */
export function platformsLine(platformNames: string[]): string {
  const names = [...new Set(platformNames)];
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return 'your channels';
}

export interface StepCopy {
  title: string;
  body: string;
  why: string;
  cta: string;
}

/** N1: the best format gets `ratio` times the worst's engagement. */
export function formatGapCopy(input: {
  best: PostFormat;
  worst: PostFormat;
  ratio: number;
  platforms: string;
}): StepCopy {
  const best = { one: SINGULAR[input.best], many: PLURAL[input.best] };
  const worst = { many: PLURAL[input.worst] };
  return {
    title: `${capitalise(best.many)} get ${input.ratio.toFixed(1)}× more engagement than ${worst.many}`,
    body: `Median engagement per post on ${input.platforms}. No ${best.one} is planned this week.`,
    why: `Your ${best.many} get the most engagement on your own posts, and none is scheduled in the next 7 days.`,
    cta: `Plan a ${best.one}`,
  };
}

/** N2: a channel that has gone quiet. */
export function quietChannelCopy(input: {
  platform: string;
  daysQuiet: number;
  cadence: string;
  lastPostOn: string;
  /** Set when followers were growing before the last post and have not since. */
  followers: { perDay: number; count: number } | null;
}): StepCopy {
  const date = shortDate(input.lastPostOn);
  const body = input.followers
    ? `Followers grew about ${Number(input.followers.perDay.toFixed(1))} a day while you posted ${input.cadence}. Since ${date} they have stayed at ${formatCompact(input.followers.count)}.`
    : `You posted ${input.cadence} until ${date}. Nothing has gone out since.`;
  return {
    title: `${input.platform} has been quiet for ${input.daysQuiet} days`,
    body,
    why: `You used to post here ${input.cadence}, and it has been longer than usual since the last one.`,
    cta: `Write a ${input.platform} post`,
  };
}

/** N3: an old post that did well and was never posted again. */
export function repostHitCopy(input: {
  publishedOn: string;
  title: string;
  platform: string;
  engagements: number;
  multiplier: number;
  ageDays: number;
}): StepCopy & { meta: string } {
  const n = formatCompact(input.engagements);
  const noun = input.engagements === 1 ? 'engagement' : 'engagements';
  return {
    title: `Your ${monthName(input.publishedOn)} hit is ready to post again`,
    body: `${input.title || 'This post'} got ${n} ${noun}, ${input.multiplier.toFixed(1)}× your usual. It is ${Math.floor(input.ageDays / 7)} weeks old.`,
    why: 'This did at least twice your usual, it is over 6 weeks old, and you haven’t posted it again.',
    cta: 'Repost',
    meta: `${input.platform} · ${shortDate(input.publishedOn)} · ${n} ${noun}`,
  };
}

/** The follower line a quiet channel's card draws: one point per reported day. */
export function followerLineOf(
  rows: FollowerRow[],
  channelId: number,
  from: string,
): { date: string; followers: number }[] {
  return rows
    .filter(
      (r) =>
        r.channelId === channelId &&
        r.followersAtEndOfDay !== null &&
        r.date >= from,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, followers: r.followersAtEndOfDay! }));
}
