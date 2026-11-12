import type { MediaItem } from '../../drizzle/schema/posts.schema';
import { channelContent } from '../../posts/lib/channel-content';

/** How many daily follower points a card's sparkline gets. */
export const FOLLOWER_SERIES_DAYS = 30;

/**
 * Platforms whose comments or messages land in the Inbox. Every other
 * channel gets `unreadCount: null` ("no inbox here"), not a misleading 0.
 * Mirrors what the ingest paths write (webhooks, InboxPollScheduler, the
 * Slack/Discord/Telegram/WhatsApp ingesters).
 */
export const INBOX_PLATFORMS: ReadonlySet<string> = new Set([
  'facebook',
  'instagram',
  'threads',
  'youtube',
  'bluesky',
  'mastodon',
  'twitter',
  'slack',
  'discord',
  'telegram',
  'whatsapp',
]);

export interface FollowerPoint {
  date: string;
  value: number;
}

/** A `date` column read back: a 'YYYY-MM-DD' string, or a Date. */
export function dayOf(value: string | Date): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

/**
 * One value per day, oldest first, at most `FOLLOWER_SERIES_DAYS` (the
 * latest ones). The daily rollup (`followers_at_end_of_day`, what Insights
 * reads) wins; a day it has no number for falls back to that day's profile
 * snapshot. Days with neither are skipped, never zero-filled.
 */
export function mergeFollowerSeries(
  daily: Array<{ date: string | Date; value: number | null }>,
  snapshots: Array<{ date: string | Date; value: number | null }>,
): FollowerPoint[] {
  const byDay = new Map<string, number>();
  for (const s of snapshots) {
    if (s.value !== null && s.value !== undefined) {
      byDay.set(dayOf(s.date), Number(s.value));
    }
  }
  for (const d of daily) {
    if (d.value !== null && d.value !== undefined) {
      byDay.set(dayOf(d.date), Number(d.value));
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-FOLLOWER_SERIES_DAYS)
    .map(([date, value]) => ({ date, value }));
}

/**
 * First-to-last change of the series in percent, one decimal. Null with
 * fewer than two points, or when the first is 0 (no meaningful percentage).
 */
export function followersChangePct(series: FollowerPoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  if (!first) return null;
  return Math.round(((last - first) / first) * 1000) / 10;
}

/** A picture for a media item: its thumbnail, else the item if it is one. */
function pictureOf(item: MediaItem | undefined): string | null {
  if (!item) return null;
  if (item.thumbnailUrl) return item.thumbnailUrl;
  return item.type === 'image' || item.type === 'gif' ? item.url : null;
}

/**
 * The thumbnail a card shows for a post going to one channel: that
 * channel's own media (its target override, else its per-platform content),
 * else the shared media - the same resolution the publisher uses.
 */
export function thumbnailFor(
  post: {
    content?: string | null;
    mediaItems?: MediaItem[] | null;
    platformContent?: unknown;
  },
  target: { platform?: string; contentOverride?: { mediaItems?: MediaItem[] } },
): string | null {
  const own = target.contentOverride?.mediaItems;
  const media =
    own && own.length > 0
      ? own
      : channelContent(post, target.platform ?? '').mediaItems;
  return pictureOf(media[0]);
}

/** The later of two instants, either of which may be missing. */
export function laterOf(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): Date | null {
  const da = a ? new Date(a) : null;
  const db = b ? new Date(b) : null;
  if (!da) return db;
  if (!db) return da;
  return da > db ? da : db;
}
