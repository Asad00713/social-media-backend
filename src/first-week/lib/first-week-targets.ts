import type { ChannelTarget } from '../../posts/composer/types/draft.types';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/** Platforms that can carry an image post (spec). TikTok and YouTube need video. */
export const IMAGE_CAPABLE_PLATFORMS = [
  'instagram',
  'facebook',
  'linkedin',
  'twitter',
  'threads',
  'bluesky',
  'mastodon',
  'pinterest',
] as const satisfies readonly SupportedPlatform[];

/** A draft aimed at one of these cannot be scheduled without an image (spec). */
export const IMAGE_REQUIRED_PLATFORMS = ['instagram', 'pinterest'] as const;

export const MIN_CAPTIONS = 3;
export const MAX_CAPTIONS = 24;
const MAX_CAPTION_CHARS = 600;

export interface ChannelLite {
  id: number;
  platform: string;
}

export interface SourceCandidate {
  channelId: number;
  platform: string;
  profilePictureUrl: string | null;
  backfilledAt: Date | null;
  /** Newest first, already cleaned. */
  captions: string[];
}

const isImageCapable = (platform: string): boolean =>
  (IMAGE_CAPABLE_PLATFORMS as readonly string[]).includes(platform);

/** Composer-shaped targets for the workspace's image-capable channels. */
export function selectTargets(channels: ChannelLite[]): ChannelTarget[] {
  return channels
    .filter((c) => isImageCapable(c.platform))
    .map((c) => ({
      channelId: String(c.id),
      platform: c.platform as SupportedPlatform,
      publishStatus: 'queued' as const,
      retryCount: 0,
    }));
}

/** Trim, drop empties, clip each caption, keep the newest 24. Input is newest first. */
export function cleanCaptions(
  raw: ReadonlyArray<string | null | undefined>,
): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text) continue;
    out.push(text.slice(0, MAX_CAPTION_CHARS));
    if (out.length === MAX_CAPTIONS) break;
  }
  return out;
}

const newestFirst = (a: SourceCandidate, b: SourceCandidate): number => {
  const at = a.backfilledAt?.getTime() ?? -Infinity;
  const bt = b.backfilledAt?.getTime() ?? -Infinity;
  if (bt !== at) return bt - at;
  return b.channelId - a.channelId;
};

/**
 * The channel Maestro learns the brand from. In order:
 *   1. the most recently backfilled image-capable channel with at least 3 captions;
 *   2. otherwise the most recently backfilled channel of any kind with at least 3;
 *   3. otherwise the channel with the most captions (the run then reports
 *      needs_description), ties broken newest-first;
 *   4. null when no channel has a caption at all.
 */
export function chooseSourceChannel(
  candidates: SourceCandidate[],
): SourceCandidate | null {
  const enough = candidates.filter((c) => c.captions.length >= MIN_CAPTIONS);
  const imageCapable = enough.filter((c) => isImageCapable(c.platform));
  if (imageCapable.length > 0) return [...imageCapable].sort(newestFirst)[0];
  if (enough.length > 0) return [...enough].sort(newestFirst)[0];

  const some = candidates.filter((c) => c.captions.length > 0);
  if (some.length === 0) return null;
  return [...some].sort(
    (a, b) => b.captions.length - a.captions.length || newestFirst(a, b),
  )[0];
}
