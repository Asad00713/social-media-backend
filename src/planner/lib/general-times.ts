import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/**
 * Curated general "best times to post", used only when a workspace has too
 * little history of its own.
 *
 * Source: Sprout Social, "Best times to post on social media" (published
 * 2026-03-31; data 2025-11-27 to 2026-02-27). The report states all times in
 * LOCAL TIME of the audience, not a single hub zone. Windows here are therefore
 * local audience time, and callers apply them as workspace-local hours.
 * `weekday` 0 = Sunday. `hour` is the start hour of a window the report names.
 * The report lists weekends as the worst days for every platform, so none appear.
 *
 * Hootsuite's report (https://blog.hootsuite.com/best-time-to-post-on-social-media/,
 * 2025-11-19) was read and NOT used: it is "time-zone agnostic" and gives one
 * to three windows per platform that contradict Sprout's (e.g. LinkedIn 4-6 AM).
 *
 * NO_PUBLISHED_RESEARCH (no reputable benchmark with >= 3 windows; they return []):
 *   youtube         (Sprout's YouTube page gives no times)
 *   threads         (Hootsuite gives a single window, Tue 8 AM; Sprout none)
 *   bluesky, mastodon, reddit, google_business
 */
export interface GeneralWindow {
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  /** 0-23, local audience time */
  hour: number;
}

export const GENERAL_TIMES: Partial<
  Record<SupportedPlatform, GeneralWindow[]>
> = {
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 12-1pm; Tue and Wed 12-8pm; Thu 12-2pm and 8pm. Local time.
  facebook: [
    { weekday: 1, hour: 12 },
    { weekday: 2, hour: 12 },
    { weekday: 2, hour: 15 },
    { weekday: 3, hour: 12 },
    { weekday: 3, hour: 15 },
    { weekday: 4, hour: 12 },
  ],
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 2-4pm; Tue 1-7pm; Wed 12-9pm and 11pm; Thu 12-2pm. Local time.
  instagram: [
    { weekday: 1, hour: 14 },
    { weekday: 2, hour: 13 },
    { weekday: 2, hour: 15 },
    { weekday: 3, hour: 12 },
    { weekday: 3, hour: 15 },
    { weekday: 4, hour: 12 },
  ],
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 1-2pm; Tue 11am-5pm; Wed 11am-4pm; Thu 11am and 1-5pm; Fri 11am and 1-2pm. Local time.
  linkedin: [
    { weekday: 1, hour: 13 },
    { weekday: 2, hour: 11 },
    { weekday: 2, hour: 13 },
    { weekday: 3, hour: 11 },
    { weekday: 4, hour: 13 },
    { weekday: 5, hour: 11 },
  ],
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 2-3pm and 5pm; Tue-Thu 12-6pm. Local time.
  twitter: [
    { weekday: 1, hour: 14 },
    { weekday: 2, hour: 12 },
    { weekday: 2, hour: 14 },
    { weekday: 3, hour: 12 },
    { weekday: 3, hour: 14 },
    { weekday: 4, hour: 12 },
  ],
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 3-5pm; Tue 2-6pm; Wed 1-8pm; Thu 1-5pm; Fri 3-5pm. Local time.
  tiktok: [
    { weekday: 1, hour: 15 },
    { weekday: 2, hour: 14 },
    { weekday: 3, hour: 13 },
    { weekday: 3, hour: 15 },
    { weekday: 4, hour: 13 },
    { weekday: 5, hour: 15 },
  ],
  // Source: Sprout Social, https://sproutsocial.com/insights/best-times-to-post-on-social-media/
  // Mon 10am-12pm and 2-3pm; Tue 7am and 10am-1pm; Wed 8am-1pm and 3pm; Thu 10-11am and 2-4pm; Fri 10-11am. Local time.
  pinterest: [
    { weekday: 1, hour: 10 },
    { weekday: 2, hour: 7 },
    { weekday: 2, hour: 10 },
    { weekday: 3, hour: 8 },
    { weekday: 4, hour: 10 },
    { weekday: 5, hour: 10 },
  ],
};

/** General windows for a platform; empty when it has no published research. */
export function generalWindowsFor(
  platform: SupportedPlatform,
): GeneralWindow[] {
  return GENERAL_TIMES[platform] ?? [];
}
