/**
 * This period in brief (spec S7.1): a few rule-based sentences about the
 * window, as segments the frontend renders (links where a segment says so).
 * No LLM: the server owns the sentences. Pure.
 */

import { round1 } from '../../post-performance/period';
import {
  firstLine,
  type InsightFormat,
  type InsightPost,
} from './insight-post';
import type { CompareMode } from './query';
import type { QuietChannel } from './quiet-channel';

/** Fewer posts than this and the brief is "too little to say". */
export const MIN_BRIEF_POSTS = 3;
/** Under this many percent either way M is "about the same". */
export const BRIEF_SAME_UNDER_PCT = 5;
/** Engagement within this many percent either way "held steady". */
export const BRIEF_STEADY_UNDER_PCT = 10;
/** Driver posts must carry at least this share of M to be named... */
export const DRIVER_HELPED_SHARE = 0.3;
/** ...and this share for "mostly from". */
export const DRIVER_MOSTLY_SHARE = 0.5;
/** "Everywhere except" needs every other channel within this many percent. */
export const OTHER_CHANNELS_WITHIN_PCT = 25;
/** A driver post is named by its caption's first line, cut to this. */
export const DRIVER_TITLE_CHARS = 40;
/** The brief shows at most this many sources. */
export const MAX_SOURCES = 3;
/** What a driver post with no caption is called. */
export const UNTITLED_POST = 'Untitled post';

export type BriefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'metric'; text: string }
  | { kind: 'post'; text: string; postId: string; channelId: number }
  | { kind: 'channel'; text: string; channelId: number };

export type BriefSource =
  | {
      kind: 'post';
      postId: string;
      channelId: number;
      title: string;
      thumbnailUrl: string | null;
      meta: string;
    }
  | { kind: 'channel'; channelId: number; title: string; meta: string };

export type Brief =
  | {
      status: 'ready';
      postsCount: number;
      channelsCount: number;
      segments: BriefSegment[];
      sources: BriefSource[];
    }
  | {
      status: 'not_enough';
      postsCount: number;
      text: string;
      suggestDays: 30 | 90 | null;
    };

/** The quiet channel and what its followers did since the last post. */
export interface BriefQuiet extends QuietChannel {
  /** Null when no channel in the selection reports followers. */
  followers: {
    count: number;
    /** Net gain since the last post. */
    gainedSince: number;
    /** Average daily gain in the days before the last post. */
    priorPerDay: number;
  } | null;
}

export interface BriefInput {
  /** Days in the window. */
  days: number;
  /** A preset says "the last 7 days"; a picked range "this period". */
  rangeKind: 'preset' | 'custom';
  compare: CompareMode;
  postsCount: number;
  /** Channels that published in the window. */
  channelsCount: number;
  /**
   * M: Views when any selected channel reports them and the total is
   * non-null, else Engagement. `deltaPct` is null without a comparison.
   */
  headline: {
    label: 'Views' | 'Engagement';
    value: number;
    deltaPct: number | null;
  };
  engagements: { value: number; deltaPct: number | null };
  /** The Above list (`standoutOf`). */
  above: InsightPost[];
  /** Engagement against each channel's usual, for the channels that posted. */
  channelDeltas: {
    channelId: number;
    posts: number;
    deltaPct: number | null;
  }[];
  quiet: BriefQuiet | null;
  /** Display platform name and account name per channel id. */
  channels: Record<number, { platform: string; name: string }>;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `Sep 30` from `2026-09-30`, by the UTC date. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const UNITS = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
] as const;

/** 5.1K, 12M: the frontend's `formatCompact` (one decimal, .0 dropped). */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  for (let i = 0; i < UNITS.length; i++) {
    const [size, suffix] = UNITS[i];
    if (abs < size) continue;
    const v = round1(n / size);
    // 999,950 rounds to 1000K, which is 1M.
    if (Math.abs(v) >= 1000 && i > 0) return formatCompact(UNITS[i - 1][0]);
    return `${v}${suffix}`;
  }
  return String(n);
}

const PLURAL: Record<InsightFormat, string> = {
  image: 'images',
  video: 'videos',
  carousel: 'carousels',
  text: 'text posts',
  link: 'link posts',
  unknown: 'posts',
};
const SINGULAR: Record<InsightFormat, string> = {
  image: 'image',
  video: 'video',
  carousel: 'carousel',
  text: 'text post',
  link: 'link post',
  unknown: 'post',
};
const LABEL: Record<InsightFormat, string> = {
  image: 'Image',
  video: 'Video',
  carousel: 'Carousel',
  text: 'Text',
  link: 'Link',
  unknown: 'Post',
};

const COMPARED_WITH: Record<Exclude<CompareMode, 'none'>, string> = {
  usual: 'your usual',
  previous: 'the previous period',
  year: 'the same period last year',
};

const pct = (d: number): number => Math.round(Math.abs(d));

/** Which longer range to offer; null when there is none worth offering. */
function suggestDaysOf(days: number): 30 | 90 | null {
  if (days <= 7) return 30;
  if (days <= 30) return 90;
  return null;
}

function notEnough(input: BriefInput): Brief {
  const n = input.postsCount;
  const suggestDays = suggestDaysOf(input.days);
  const where =
    input.rangeKind === 'preset'
      ? `the last ${input.days} days`
      : 'this period';
  const went =
    n === 0
      ? `No posts went out in ${where}`
      : `Only ${n} post${n === 1 ? '' : 's'} went out in ${where}`;
  const tail =
    suggestDays === null
      ? 'Check back after a few more posts.'
      : `Try ${suggestDays} days, or check back after a few more posts.`;
  return {
    status: 'not_enough',
    postsCount: n,
    text: `${went}, so there isn’t enough to compare yet. ${tail}`,
    suggestDays,
  };
}

const titleOf = (p: InsightPost): string =>
  firstLine(p.title, DRIVER_TITLE_CHARS) || UNTITLED_POST;

/** Up to 2 Above posts by M, and the share of M they carry. */
function driversOf(
  input: BriefInput,
): { posts: InsightPost[]; share: number } | null {
  const { above, headline, engagements } = input;
  const onViews =
    headline.label === 'Views' && above.some((p) => p.impressions !== null);
  const valueOf = (p: InsightPost): number | null =>
    onViews ? p.impressions : p.engagements;
  const total = onViews ? headline.value : engagements.value;
  const posts = above
    .filter((p) => valueOf(p) !== null)
    .sort((a, b) => valueOf(b)! - valueOf(a)!)
    .slice(0, 2);
  if (!posts.length || total <= 0) return null;
  const sum = posts.reduce((acc, p) => acc + valueOf(p)!, 0);
  return { posts, share: sum / total };
}

function driverSegments(
  posts: InsightPost[],
  channels: BriefInput['channels'],
): BriefSegment[] {
  const link = (p: InsightPost): BriefSegment => ({
    kind: 'post',
    text: titleOf(p),
    postId: p.postId,
    channelId: p.channelId,
  });
  const platformOf = (p: InsightPost): string =>
    channels[p.channelId]?.platform ?? '';
  if (posts.length === 1) {
    const [a] = posts;
    return [
      { kind: 'text', text: `one ${platformOf(a)} ${SINGULAR[a.format]}: ` },
      link(a),
    ];
  }
  const [a, b] = posts;
  const same = platformOf(a) === platformOf(b) && a.format === b.format;
  return [
    {
      kind: 'text',
      text: same ? `two ${platformOf(a)} ${PLURAL[a.format]}: ` : 'two posts: ',
    },
    link(a),
    { kind: 'text', text: ' and ' },
    link(b),
  ];
}

function sourceOf(p: InsightPost): BriefSource {
  const n = p.engagements;
  const parts = [
    LABEL[p.format],
    `${formatCompact(n)} engagement${n === 1 ? '' : 's'}`,
  ];
  if (p.usualMultiplier !== null) parts.push(`${p.usualMultiplier}× usual`);
  return {
    kind: 'post',
    postId: p.postId,
    channelId: p.channelId,
    title: titleOf(p),
    thumbnailUrl: p.thumbnailUrl,
    meta: parts.join(' · '),
  };
}

/** Sentence 2: how engagement held, and the channel that went quiet. */
function engagementSentence(
  input: BriefInput,
): { segments: BriefSegment[]; source: BriefSource | null } | null {
  const { engagements, quiet, headline, channels, channelDeltas } = input;
  const e = engagements.deltaPct;
  if (headline.label === 'Engagement' && e === null) return null;

  let base = '';
  if (e !== null) {
    base =
      Math.abs(e) < BRIEF_STEADY_UNDER_PCT
        ? 'Engagement held steady'
        : `Engagement was ${e > 0 ? 'up' : 'down'} ${pct(e)}%`;
  }
  if (!quiet) {
    return e === null
      ? null
      : {
          segments: [{ kind: 'text', text: ` ${base} across your channels.` }],
          source: null,
        };
  }

  const platform = channels[quiet.channelId]?.platform ?? '';
  const name = channels[quiet.channelId]?.name ?? platform;
  const stayed =
    quiet.followers &&
    quiet.followers.gainedSince === 0 &&
    quiet.followers.priorPerDay >= 1
      ? `, and its followers have stayed at ${formatCompact(quiet.followers.count)}`
      : '';
  const noPosts: BriefSegment = {
    kind: 'channel',
    text: `no posts since ${shortDate(quiet.lastPostOn)}`,
    channelId: quiet.channelId,
  };
  // A null delta is not known to be steady, so it does not count as within.
  const everywhere =
    e !== null &&
    channelDeltas
      .filter((c) => c.channelId !== quiet.channelId && c.posts > 0)
      .every(
        (c) =>
          c.deltaPct !== null &&
          Math.abs(c.deltaPct) < OTHER_CHANNELS_WITHIN_PCT,
      );

  let lead: string;
  if (e === null) lead = ` ${platform} has had `;
  else if (everywhere) {
    lead = ` ${base} everywhere except ${platform}, which has had `;
  } else lead = ` ${base}. ${platform} has had `;

  return {
    segments: [
      { kind: 'text', text: lead },
      noPosts,
      { kind: 'text', text: `${stayed}.` },
    ],
    source: {
      kind: 'channel',
      channelId: quiet.channelId,
      title: `${name} · ${platform}`,
      meta: `Last post ${shortDate(quiet.lastPostOn)}`,
    },
  };
}

export function buildBrief(input: BriefInput): Brief {
  if (input.postsCount < MIN_BRIEF_POSTS) return notEnough(input);

  const { headline, compare, postsCount } = input;
  const d = compare === 'none' ? null : headline.deltaPct;
  const cmp = compare === 'none' ? '' : COMPARED_WITH[compare];
  const segments: BriefSegment[] = [];
  const sources: BriefSource[] = [];

  // Sentence 1: M against the comparison.
  if (d === null) {
    segments.push({
      kind: 'text',
      text: `${headline.label} reached ${formatCompact(headline.value)} from ${postsCount} posts`,
    });
  } else if (Math.abs(d) < BRIEF_SAME_UNDER_PCT) {
    segments.push({
      kind: 'text',
      text: `${headline.label} was about the same as ${cmp}`,
    });
  } else {
    segments.push(
      { kind: 'text', text: `${headline.label} was ` },
      {
        kind: 'metric',
        text: `${pct(d)}% ${d > 0 ? 'above' : 'below'} ${cmp}`,
      },
    );
  }

  // Drivers, only when M is up or has nothing to be compared with.
  if (d === null || d >= BRIEF_SAME_UNDER_PCT) {
    const drivers = driversOf(input);
    if (drivers && drivers.share >= DRIVER_HELPED_SHARE) {
      segments.push(
        {
          kind: 'text',
          text:
            drivers.share >= DRIVER_MOSTLY_SHARE
              ? ', mostly from '
              : ', helped most by ',
        },
        ...driverSegments(drivers.posts, input.channels),
      );
      sources.push(...drivers.posts.map(sourceOf));
    }
  }
  segments.push({ kind: 'text', text: '.' });

  const second = engagementSentence(input);
  if (second) {
    segments.push(...second.segments);
    if (second.source) sources.push(second.source);
  }

  return {
    status: 'ready',
    postsCount,
    channelsCount: input.channelsCount,
    segments,
    sources: sources.slice(0, MAX_SOURCES),
  };
}
