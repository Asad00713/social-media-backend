import type {
  EvergreenCategoryScheduleJson,
  EvergreenPost,
  EvergreenSeasonalJson,
  RecyclePolicyJson,
} from '../drizzle/schema/evergreen.schema';

// ---------------------------------------------------------------------------
// Timezone helpers (replicated from campaign-schedule.util.ts — not exported
// there, so we keep a private DST-correct copy here rather than inventing a
// naive `new Date(string)` conversion).
// ---------------------------------------------------------------------------

/** Offset (minutes) of `timeZone` from UTC at the given UTC instant.
 *  Positive means east of UTC (e.g. Asia/Karachi → +300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Convert wall-clock `date` (yyyy-MM-dd) + `time` (HH:mm) in `timeZone` to a
 *  UTC Date. Falls back to treating the wall-clock as UTC if the zone is
 *  invalid. Returns null if date/time are malformed. */
function wallClockToUtc(date: string, time: string, timeZone: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  // First approximation: treat the wall-clock as UTC.
  const naiveUtcMs = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0);
  let offsetMin = 0;
  try {
    offsetMin = zoneOffsetMinutes(timeZone, new Date(naiveUtcMs));
  } catch {
    offsetMin = 0; // invalid zone → UTC fallback
  }
  // Real UTC instant = wall-clock minus the zone's offset.
  return new Date(naiveUtcMs - offsetMin * 60000);
}

/** Format a UTC-midnight-anchored y/m/d as yyyy-MM-dd. */
function formatDate(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// computeNextCategoryFire
// ---------------------------------------------------------------------------

const MAX_SCAN_DAYS = 366;

/**
 * Find the next instant, strictly after `after`, that matches one of
 * `schedule.weekdays` (0=Sun..6=Sat) at one of `schedule.times` (HH:mm),
 * interpreted in `timezone`, skipping any date present in `blackoutDates`.
 * Scans day-by-day up to `MAX_SCAN_DAYS` days from `after`. Returns null if
 * no weekdays are configured or nothing is found within the scan window.
 */
export function computeNextCategoryFire(
  schedule: EvergreenCategoryScheduleJson,
  timezone: string,
  blackoutDates: string[],
  after: Date,
): Date | null {
  if (!schedule.weekdays || schedule.weekdays.length === 0) return null;
  if (!schedule.times || schedule.times.length === 0) return null;

  const weekdaySet = new Set(schedule.weekdays);
  const blackoutSet = new Set(blackoutDates ?? []);
  const sortedTimes = [...schedule.times].sort();

  // Anchor the scan at the UTC calendar day of `after` and walk forward.
  const startY = after.getUTCFullYear();
  const startM = after.getUTCMonth() + 1;
  const startD = after.getUTCDate();
  const startUtcMidnight = Date.UTC(startY, startM - 1, startD);

  for (let dayOffset = 0; dayOffset <= MAX_SCAN_DAYS; dayOffset++) {
    const dayMs = startUtcMidnight + dayOffset * 86400000;
    const dayDate = new Date(dayMs);
    const y = dayDate.getUTCFullYear();
    const m = dayDate.getUTCMonth() + 1;
    const d = dayDate.getUTCDate();
    const weekday = dayDate.getUTCDay();

    if (!weekdaySet.has(weekday)) continue;

    const dateStr = formatDate(y, m, d);
    if (blackoutSet.has(dateStr)) continue;

    for (const time of sortedTimes) {
      const candidate = wallClockToUtc(dateStr, time, timezone);
      if (!candidate) continue;
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// isPostEligible
// ---------------------------------------------------------------------------

function isWithinSeasonalWindow(seasonal: EvergreenSeasonalJson | null, now: Date): boolean {
  if (!seasonal) return true;
  const start = wallClockToUtc(seasonal.startDate, '00:00', 'UTC');
  // End date is inclusive through end-of-day.
  const end = wallClockToUtc(seasonal.endDate, '23:59', 'UTC');
  if (!start || !end) return true; // malformed window — don't block on bad data
  return now.getTime() >= start.getTime() && now.getTime() <= end.getTime();
}

function isPolicySatisfied(policy: RecyclePolicyJson, recycledCount: number, now: Date): boolean {
  if (policy.mode === 'maxCount') {
    if (policy.maxCount == null) return true;
    return recycledCount < policy.maxCount;
  }
  if (policy.mode === 'expiry') {
    if (!policy.expiryDate) return true;
    const expiry = wallClockToUtc(policy.expiryDate, '23:59', 'UTC');
    if (!expiry) return true;
    return now.getTime() <= expiry.getTime();
  }
  return true; // 'forever'
}

function isMinGapSatisfied(minGapHours: number, lastPublishedAt: Date | null, now: Date): boolean {
  if (!minGapHours || minGapHours <= 0) return true;
  if (!lastPublishedAt) return true;
  const gapMs = now.getTime() - lastPublishedAt.getTime();
  return gapMs >= minGapHours * 3600000;
}

/**
 * True when a post can fire right now: post is 'active', its category is
 * active, `now` falls within the category's seasonal window (if any), the
 * recycle policy hasn't been exhausted, and the min-gap since last publish
 * has elapsed.
 */
export function isPostEligible(
  post: EvergreenPost,
  category: { isActive: boolean; seasonal: EvergreenSeasonalJson | null },
  now: Date,
): boolean {
  if (post.status !== 'active') return false;
  if (!category.isActive) return false;
  if (!isWithinSeasonalWindow(category.seasonal, now)) return false;
  if (!isPolicySatisfied(post.recyclePolicy as RecyclePolicyJson, post.recycledCount, now)) return false;
  if (!isMinGapSatisfied(post.minGapHours, post.lastPublishedAt, now)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// pickNextPost
// ---------------------------------------------------------------------------

/**
 * Filter to eligible posts, then rank least-recently-published-first (a
 * never-published post — `lastPublishedAt === null` — ranks highest), scaled
 * by a D2 performance multiplier `(0.5 + (performanceScore ?? 0.5))` so a
 * null score is neutral (×1.0) and never excludes a post. Deterministic: on
 * an exact tie the first post in input order wins. Returns null when no
 * post is eligible.
 */
export function pickNextPost(
  posts: EvergreenPost[],
  category: { isActive: boolean; seasonal: EvergreenSeasonalJson | null },
  now: Date,
): EvergreenPost | null {
  const eligible = posts.filter((p) => isPostEligible(p, category, now));
  if (eligible.length === 0) return null;

  // Base "age priority": larger = should fire sooner. Never-published posts
  // get the largest possible value so they always sort first among ties.
  const agePriority = (p: EvergreenPost): number => {
    if (!p.lastPublishedAt) return Number.MAX_SAFE_INTEGER;
    // Older lastPublishedAt → smaller timestamp → larger "time since" → higher priority.
    return now.getTime() - p.lastPublishedAt.getTime();
  };

  let best: EvergreenPost | null = null;
  let bestScore = -Infinity;
  for (const p of eligible) {
    const multiplier = 0.5 + (p.performanceScore ?? 0.5);
    const score = agePriority(p) * multiplier;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// selectVariation
// ---------------------------------------------------------------------------

/**
 * Cycle base → variation[0] → variation[1] → ... by
 * `recycledCount % (variations.length + 1)`. Index 0 = base content's
 * caption (variationId null); index N (N>0) = `variations[N-1]`.
 */
export function selectVariation(post: EvergreenPost): { variationId: string | null; caption: string } {
  const variations = post.variations ?? [];
  const cycleLength = variations.length + 1;
  const index = cycleLength > 0 ? post.recycledCount % cycleLength : 0;

  if (index === 0) {
    return { variationId: null, caption: post.content.caption };
  }
  const variation = variations[index - 1];
  return { variationId: variation.id, caption: variation.caption };
}
