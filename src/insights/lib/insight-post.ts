import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import {
  addDays,
  isoDate,
  round1,
  utcToday,
} from '../../post-performance/period';
import { multiplierOf } from './usual-multiplier';

export const POST_FORMATS = [
  'image',
  'video',
  'carousel',
  'link',
  'text',
] as const;
export type PostFormat = (typeof POST_FORMATS)[number];
/** `unknown`: an imported post whose platform didn't say what it was. */
export type InsightFormat = PostFormat | 'unknown';

/** One post on one channel, as the Insights page shows it. */
export interface InsightPost {
  postId: string;
  channelId: number;
  publishedAt: string;
  /** The caption's first line, at most TITLE_CHARS; '' without a caption. */
  title: string;
  content: string;
  format: InsightFormat;
  thumbnailUrl: string | null;
  permalink: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number;
  /** Engagements ÷ impressions × 100, one decimal; null without impressions. */
  engagementRate: number | null;
  /** Imported from the platform rather than composed in Schedura. */
  imported: boolean;
  /**
   * Engagements over the channel's usual (see `multiplierOf`); null when not
   * measured, below the floor, or when no usual was loaded for this list.
   */
  usualMultiplier: number | null;
  /** Out on or after `settlingFrom` (whole UTC days): numbers can still change. */
  isSettling: boolean;
}

/** Cards and the table show this much of a caption; the CSV gets all of it. */
export const CAPTION_PREVIEW_CHARS = 280;

/** A post's title: its caption's first line, cut to this many characters. */
export const TITLE_CHARS = 120;

/**
 * Whole UTC days before today still settling: a window ending yesterday has
 * its last 2 days shaded (Meta documents up to 48 h of delay).
 */
export const SETTLING_DAYS = 2;

/** A whole http(s) URL somewhere in the caption. */
const URL_IN_TEXT = /https?:\/\/\S+/;

/** Every post on these platforms is a video, whatever was stored. */
const VIDEO_PLATFORMS = new Set(['youtube', 'tiktok']);

/** What the Instagram, Threads and X adapters record as `mediaType`. */
const REPORTED_FORMAT = new Map<string, PostFormat>([
  ['IMAGE', 'image'],
  ['photo', 'image'],
  ['VIDEO', 'video'],
  ['REELS', 'video'],
  ['video', 'video'],
  ['animated_gif', 'video'],
  ['CAROUSEL_ALBUM', 'carousel'],
  ['TEXT', 'text'],
  ['TEXT_POST', 'text'],
]);

/**
 * The post's format: the platform first, then a link post (no media and a URL
 * in the caption), then what the platform reported, then the media we
 * composed. An imported post's media is always stored as `image`, so for one
 * the platform hasn't described we say `unknown` rather than guess.
 */
export function classifyFormat(
  p: PublishedPost,
  platform: string,
): InsightFormat {
  if (VIDEO_PLATFORMS.has(platform)) return 'video';
  if (p.mediaItems.length === 0 && URL_IN_TEXT.test(p.content)) return 'link';
  const reported = p.mediaType ? REPORTED_FORMAT.get(p.mediaType) : undefined;
  if (reported) return reported;
  if (p.imported) return 'unknown';

  const items = p.mediaItems;
  if (items.length === 0) return 'text';
  if (items.length > 1 || items.some((i) => i.type === 'carousel')) {
    return 'carousel';
  }
  if (items.some((i) => i.type === 'video')) return 'video';
  return 'image';
}

/** The first `n` characters, counted by code point so an emoji isn't split. */
const preview = (s: string, n: number): string =>
  s.length <= n ? s : Array.from(s).slice(0, n).join('');

/**
 * The caption's first non-blank line, trimmed. Longer than `max` characters
 * (code points) it is cut to `max`, the last one an ellipsis.
 */
export function firstLine(content: string, max = TITLE_CHARS): string {
  const line =
    content
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The first UTC day still settling at `now`: today minus SETTLING_DAYS. The
 * chart shades from here (`stillCollectingFrom`).
 */
export function settlingFrom(now: Date): string {
  return addDays(isoDate(utcToday(now)), -SETTLING_DAYS);
}

/**
 * Whether the post went out on or after `settlingFrom(now)`. By whole UTC
 * days, not hours, so a post's Settling badge and the chart's shaded zone
 * always agree.
 */
export function isSettling(
  p: Pick<PublishedPost, 'publishedOn'>,
  now: Date,
): boolean {
  return p.publishedOn >= settlingFrom(now);
}

export interface InsightPostOptions {
  /** How much caption to keep; null keeps all of it. */
  captionChars?: number | null;
  /** Each channel's usual engagements; without it the multiplier is null. */
  usual?: Map<number, number[]>;
  now: Date;
}

export function toInsightPost(
  p: PublishedPost,
  platform: string,
  opts: InsightPostOptions,
): InsightPost {
  const captionChars =
    opts.captionChars === undefined ? CAPTION_PREVIEW_CHARS : opts.captionChars;
  const engagements = engagementsOf(p);
  const first = p.mediaItems[0];
  return {
    postId: p.postId,
    channelId: p.channelId,
    publishedAt: p.publishedAt,
    title: firstLine(p.content),
    content:
      captionChars === null ? p.content : preview(p.content, captionChars),
    format: classifyFormat(p, platform),
    thumbnailUrl: first ? (first.thumbnailUrl ?? first.url) : null,
    permalink: p.permalink,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    impressions: p.impressions,
    reach: p.reach,
    engagements,
    engagementRate: p.impressions
      ? round1((engagements / p.impressions) * 100)
      : null,
    imported: p.imported,
    usualMultiplier: opts.usual ? multiplierOf(p, opts.usual) : null,
    isSettling: isSettling(p, opts.now),
  };
}
