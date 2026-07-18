const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface YoutubeInboxTier {
  name: 'hot' | 'warm' | 'cool' | 'cold';
  maxAgeMs: number;
  intervalMs: number;
}

/**
 * How often a video's comments may be polled, by video age.
 *
 * Comments arrive overwhelmingly on recent uploads, so a fixed interval is
 * either wasteful on old videos or too slow on new ones. The cold cutoff sits
 * at 30 days to match the existing inbox polling window (POLLING_WINDOW_DAYS
 * in inbox-poll.processor.ts), so no currently-polled video is dropped.
 *
 * Shape mirrors POST_POLLING_TIERS in
 * channels/analytics/utils/polling-tier.util.ts — the same idea for analytics.
 */
export const YOUTUBE_INBOX_TIERS: YoutubeInboxTier[] = [
  { name: 'hot', maxAgeMs: 2 * DAY, intervalMs: 15 * MIN },
  { name: 'warm', maxAgeMs: 7 * DAY, intervalMs: 1 * HOUR },
  { name: 'cool', maxAgeMs: 30 * DAY, intervalMs: 6 * HOUR },
  {
    name: 'cold',
    maxAgeMs: Number.POSITIVE_INFINITY,
    intervalMs: Number.POSITIVE_INFINITY,
  },
];

/** The tier whose maxAgeMs is the smallest one that exceeds the given age. */
export function pickYoutubeInboxTier(ageMs: number): YoutubeInboxTier {
  for (const tier of YOUTUBE_INBOX_TIERS) {
    if (ageMs < tier.maxAgeMs) return tier;
  }
  return YOUTUBE_INBOX_TIERS[YOUTUBE_INBOX_TIERS.length - 1];
}

/**
 * Whether a video is due for another comment poll.
 *
 * A never-polled video is due immediately — except in the cold tier, whose
 * infinite interval means "never", never-polled included.
 */
export function isDueForPoll(
  tier: YoutubeInboxTier,
  lastPolledAtMs: number | null,
  nowMs: number,
): boolean {
  if (!Number.isFinite(tier.intervalMs)) return false;
  if (lastPolledAtMs === null) return true;
  return nowMs - lastPolledAtMs >= tier.intervalMs;
}
