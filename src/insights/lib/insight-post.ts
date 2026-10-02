import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import { round1 } from '../../post-performance/period';

export const POST_FORMATS = ['image', 'video', 'carousel', 'text'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];
/** `unknown`: an imported post whose platform didn't say what it was. */
export type InsightFormat = PostFormat | 'unknown';

/** One post on one channel, as the Insights page shows it. */
export interface InsightPost {
  postId: string;
  channelId: number;
  publishedAt: string;
  content: string;
  format: InsightFormat;
  thumbnailUrl: string | null;
  permalink: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  engagements: number;
  /** Engagements ÷ impressions × 100, one decimal; null without impressions. */
  engagementRate: number | null;
}

/** Cards and the table show this much of a caption; the CSV gets all of it. */
export const CAPTION_PREVIEW_CHARS = 280;

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
 * The post's format: the platform first, then what the platform reported,
 * then the media we composed. An imported post's media is always stored as
 * `image`, so for one the platform hasn't described we say `unknown` rather
 * than guess.
 */
export function classifyFormat(
  p: PublishedPost,
  platform: string,
): InsightFormat {
  if (VIDEO_PLATFORMS.has(platform)) return 'video';
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

/** `captionChars: null` keeps the whole caption. */
export function toInsightPost(
  p: PublishedPost,
  platform: string,
  captionChars: number | null = CAPTION_PREVIEW_CHARS,
): InsightPost {
  const engagements = engagementsOf(p);
  const first = p.mediaItems[0];
  return {
    postId: p.postId,
    channelId: p.channelId,
    publishedAt: p.publishedAt,
    content:
      captionChars === null ? p.content : preview(p.content, captionChars),
    format: classifyFormat(p, platform),
    thumbnailUrl: first ? (first.thumbnailUrl ?? first.url) : null,
    permalink: p.permalink,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    impressions: p.impressions,
    engagements,
    engagementRate: p.impressions
      ? round1((engagements / p.impressions) * 100)
      : null,
  };
}
