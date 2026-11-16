import { classifyPublishError } from '../../posts/composer/services/composer-error-mapper.service';
import type {
  MeasuredReason,
  PlatformSignalsSummary,
  PlatformState,
} from '../../drizzle/schema/platform-status.schema';
import { stateRank } from './status-platforms';

// ---------------------------------------------------------------------------
// Thresholds. Each one trades a false alarm (every customer on the platform
// is told it is broken) against a late one. A false alarm is the worse of
// the two: it teaches people to ignore the toast.
// ---------------------------------------------------------------------------

/** How far back publish outcomes count. Long enough to collect a sample on
 *  a quiet platform, short enough that a recovery shows within half an hour. */
export const PUBLISH_WINDOW_MS = 30 * 60_000;

/** How far back profile syncs count. Syncs run once a day per channel (at
 *  02:00 UTC) plus manual refreshes, so this is mostly the morning burst. */
export const SYNC_WINDOW_MS = 2 * 60 * 60_000;

/** Scheduled posts further back than this are not a lag sample: anything
 *  published that late was a person pressing Publish again, not the queue. */
export const MAX_LAG_SAMPLE_MS = 6 * 60 * 60_000;

/** No platform is called anything but operational on fewer outcomes than
 *  this: three failures out of five is noise, not an outage. */
export const MIN_PUBLISH_SAMPLE = 10;

/** Scheduled posts that went out (or are still waiting) needed to judge lag. */
export const MIN_LAG_SAMPLE = 5;

/** Synced channels needed to judge sync health. */
export const MIN_SYNC_SAMPLE = 10;

/** The bad outcomes must come from at least this many workspaces, so one
 *  account's broken token, bad media or spam block never flags a platform. */
export const MIN_DISTINCT_WORKSPACES = 3;

/** Share of platform-side publish failures that reads "delayed". Platform
 *  hiccups (a 503, a timeout) normally stay in low single digits. */
export const DELAYED_FAILURE_RATE = 0.2;

/** Share of platform-side publish failures that reads "outage": most posts
 *  are failing, not a few. */
export const OUTAGE_FAILURE_RATE = 0.6;

/** Median lag of scheduled posts that reads "delayed". A video can take a
 *  few minutes to process on Instagram, TikTok or YouTube, so the bar sits
 *  above that. Lag alone never reads "outage": late is not failed. */
export const DELAYED_LAG_MS = 10 * 60_000;

/** Share of platform-side sync failures that reads "delayed". Sync uses the
 *  networks' read APIs, not publishing, so it only ever raises "delayed", and
 *  only when half the channels are failing. */
export const DELAYED_SYNC_SHARE = 0.5;

/** Late platforms that, together, read as our own queue being behind:
 *  three networks slowing down in the same half hour is not a coincidence. */
export const QUEUE_BACKLOG_MIN_PLATFORMS = 3;

/** ...and the share of platforms with a lag sample that must be late. */
export const QUEUE_BACKLOG_SHARE = 0.5;

/** Hysteresis: a platform already in a state keeps it until its numbers fall
 *  below this fraction of the bar that put it there, so a rate hovering at
 *  the bar does not flap between two states every two minutes. */
export const RECOVERY_FACTOR = 0.5;

// ---------------------------------------------------------------------------

/** One channel publish attempt that finished in the window. */
export interface PublishOutcome {
  workspaceId: string;
  result: 'published' | 'failed';
  /** The composer's classified code, when the composer published it. */
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** How late one scheduled post went out (or how late it is so far). */
export interface LagSample {
  workspaceId: string;
  lagMs: number;
}

/** One channel's latest profile sync in the window. */
export interface SyncSample {
  workspaceId: string;
  result: 'success' | 'failed' | 'rate_limited';
  errorMessage?: string | null;
}

export interface PlatformSignals {
  publishes: PublishOutcome[];
  lags: LagSample[];
  syncs: SyncSample[];
}

export interface Measurement {
  status: PlatformState;
  reason: MeasuredReason | null;
  summary: PlatformSignalsSummary;
}

/** Errors that say the network itself is struggling: 5xx, gateway errors,
 *  "temporarily unavailable". The composer's classifier calls these
 *  `permanent`, which is right for a retry decision but not for health. */
const PLATFORM_SIDE_RE =
  /\b50[0-4]\b|service unavailable|internal server error|bad gateway|gateway time-?out|temporarily unavailable|server error|timed? ?out|econnrefused|enotfound|eai_again/i;

/** Our own per-channel limiter ("Channel rate limit exceeded..." on the
 *  target, "Per-channel rate limit exceeded" in the history): one account
 *  posting a lot, never the network. */
const OWN_CHANNEL_LIMIT_RE = /channel rate limit exceeded/i;

/**
 * Is this failure the network's fault (counts against the platform), the
 * customer's (bad media, rejected content, expired token: ignored), or not a
 * failure at all? Unknown errors are ignored: only errors that read as the
 * network struggling may flag it.
 */
export function failureSide(
  outcome: Pick<PublishOutcome, 'result' | 'errorCode' | 'errorMessage'>,
): 'ok' | 'platform' | 'customer' {
  if (outcome.result === 'published') return 'ok';
  const message = outcome.errorMessage?.trim() ?? '';
  if (OWN_CHANNEL_LIMIT_RE.test(message)) return 'customer';
  const code =
    outcome.errorCode && outcome.errorCode !== 'permanent'
      ? outcome.errorCode
      : message
        ? classifyPublishError(message).code
        : 'permanent';
  if (code === 'transient' || code === 'rate_limited') return 'platform';
  if (code === 'permanent' && PLATFORM_SIDE_RE.test(message)) {
    return 'platform';
  }
  return 'customer';
}

function syncSide(sample: SyncSample): 'ok' | 'platform' | 'customer' {
  if (sample.result === 'success') return 'ok';
  if (sample.result === 'rate_limited') return 'platform';
  return failureSide({ result: 'failed', errorMessage: sample.errorMessage });
}

function distinct(values: string[]): number {
  return new Set(values).size;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** True when a platform already at (or above) `level` is measured again. */
function holds(level: PlatformState, previous: PlatformState): boolean {
  return stateRank(previous) >= stateRank(level);
}

/**
 * The bar a metric must reach for `level`. A platform already at (or above)
 * that level keeps it down to RECOVERY_FACTOR of the bar.
 */
function bar(
  entry: number,
  level: PlatformState,
  previous: PlatformState,
): number {
  return holds(level, previous) ? entry * RECOVERY_FACTOR : entry;
}

/**
 * Whether a sample is big and wide enough to call `level`. The same
 * hold-until-clearly-better rule as the bars: a platform already at the
 * level keeps it on RECOVERY_FACTOR of the minimum sample and one workspace
 * fewer (never below two), so a count hovering at 3 workspaces does not
 * flap the platform every two minutes.
 */
function enough(
  sample: number,
  workspaces: number,
  minSample: number,
  level: PlatformState,
  previous: PlatformState,
): boolean {
  if (!holds(level, previous)) {
    return sample >= minSample && workspaces >= MIN_DISTINCT_WORKSPACES;
  }
  return (
    sample >= Math.ceil(minSample * RECOVERY_FACTOR) &&
    workspaces >= Math.max(2, MIN_DISTINCT_WORKSPACES - 1)
  );
}

export interface MeasureOptions {
  /**
   * Ignore the lag signal: most platforms are late together, which is our
   * own publishing queue, not any one network (see measureAll).
   */
  ignoreLag?: boolean;
}

/** The lag numbers of one platform. */
function lagOf(signals: PlatformSignals, previous: PlatformState) {
  const lags = signals.lags.filter(
    (l) => l.lagMs >= 0 && l.lagMs <= MAX_LAG_SAMPLE_MS,
  );
  const medianLag = median(lags.map((l) => l.lagMs));
  const threshold = bar(DELAYED_LAG_MS, 'delayed', previous);
  const workspaces = distinct(
    lags.filter((l) => l.lagMs >= threshold).map((l) => l.workspaceId),
  );
  const late =
    enough(lags.length, workspaces, MIN_LAG_SAMPLE, 'delayed', previous) &&
    medianLag !== null &&
    medianLag >= threshold;
  return { lags, medianLag, workspaces, late };
}

/**
 * Measures one platform from its signals. `previous` is the last measured
 * state (not the shown one: an incident must not make the measurement
 * sticky).
 */
export function measurePlatform(
  signals: PlatformSignals,
  previous: PlatformState = 'operational',
  options: MeasureOptions = {},
): Measurement {
  // Publish failures: only outcomes that say something about the network.
  const judged = signals.publishes
    .map((o) => ({ ws: o.workspaceId, side: failureSide(o) }))
    .filter((o) => o.side !== 'customer');
  const failed = judged.filter((o) => o.side === 'platform');
  const failureWorkspaces = distinct(failed.map((o) => o.ws));
  const failureRate = judged.length ? failed.length / judged.length : 0;
  const publishEnough = (level: PlatformState) =>
    enough(
      judged.length,
      failureWorkspaces,
      MIN_PUBLISH_SAMPLE,
      level,
      previous,
    );

  const lag = lagOf(signals, previous);

  // Sync failures.
  const syncs = signals.syncs
    .map((s) => ({ ws: s.workspaceId, side: syncSide(s) }))
    .filter((s) => s.side !== 'customer');
  const syncFailed = syncs.filter((s) => s.side === 'platform');
  const syncWorkspaces = distinct(syncFailed.map((s) => s.ws));
  const syncShare = syncs.length ? syncFailed.length / syncs.length : 0;

  const summary: PlatformSignalsSummary = {
    publishSample: judged.length,
    publishFailures: failed.length,
    publishFailureWorkspaces: failureWorkspaces,
    lagSample: lag.lags.length,
    medianLagMs: lag.medianLag,
    lagWorkspaces: lag.workspaces,
    syncSample: syncs.length,
    syncFailures: syncFailed.length,
    syncFailureWorkspaces: syncWorkspaces,
  };

  if (
    publishEnough('outage') &&
    failureRate >= bar(OUTAGE_FAILURE_RATE, 'outage', previous)
  ) {
    return { status: 'outage', reason: 'publish_failures', summary };
  }
  if (
    publishEnough('delayed') &&
    failureRate >= bar(DELAYED_FAILURE_RATE, 'delayed', previous)
  ) {
    return { status: 'delayed', reason: 'publish_failures', summary };
  }
  if (lag.late && !options.ignoreLag) {
    return { status: 'delayed', reason: 'publish_lag', summary };
  }
  if (
    enough(
      syncs.length,
      syncWorkspaces,
      MIN_SYNC_SAMPLE,
      'delayed',
      previous,
    ) &&
    syncShare >= bar(DELAYED_SYNC_SHARE, 'delayed', previous)
  ) {
    return { status: 'delayed', reason: 'sync_failures', summary };
  }
  return { status: 'operational', reason: null, summary };
}

/**
 * Every platform at once. Lag is judged across platforms first: when at
 * least QUEUE_BACKLOG_MIN_PLATFORMS platforms, and at least
 * QUEUE_BACKLOG_SHARE of those with enough lag samples, are late together,
 * the delay is our own publishing queue (one worker pool serves every
 * network), so no platform is blamed for it.
 */
export function measureAll(
  signals: Map<string, PlatformSignals>,
  platforms: readonly string[],
  previous: (platform: string) => PlatformState,
): Map<string, Measurement> {
  const empty: PlatformSignals = { publishes: [], lags: [], syncs: [] };
  let judgeable = 0;
  let late = 0;
  for (const platform of platforms) {
    const lag = lagOf(signals.get(platform) ?? empty, previous(platform));
    if (lag.lags.length >= MIN_LAG_SAMPLE) judgeable += 1;
    if (lag.late) late += 1;
  }
  const ignoreLag =
    late >= QUEUE_BACKLOG_MIN_PLATFORMS &&
    judgeable > 0 &&
    late / judgeable >= QUEUE_BACKLOG_SHARE;
  const out = new Map<string, Measurement>();
  for (const platform of platforms) {
    out.set(
      platform,
      measurePlatform(signals.get(platform) ?? empty, previous(platform), {
        ignoreLag,
      }),
    );
  }
  return out;
}
