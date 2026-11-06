import { PLATFORM_CAPABILITIES } from '../../channels/analytics/platform-capabilities.registry';
import type { BackfillStatus } from '../../drizzle/schema/channel-sync-state.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/** Failed syncs in a row before a channel counts as failing. */
export const FAILING_AFTER = 3;

export interface SyncStateRow {
  channelId: number;
  lastProfileSyncAt: Date | null;
  lastPostsSyncAt: Date | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
  initialBackfillStatus: BackfillStatus;
}

/** The channel fields freshness reads. */
export interface FreshnessChannel {
  id: number;
  /** A `SupportedPlatform`; any other string reports nothing. */
  platform: string;
  /** False when paused by hand or locked by the plan. */
  isActive: boolean;
  connectionStatus: string;
}

export interface ChannelFreshness {
  channelId: number;
  /** The later of the profile and posts syncs; null when never synced. */
  lastSyncedAt: string | null;
  failing: boolean;
  isActive: boolean;
  connectionStatus: string;
  /** The first history import; `pending` before the sync state row exists. */
  backfill: BackfillStatus;
  /** What the platform shares, from its capabilities; all false without any. */
  reportsViews: boolean;
  reportsReach: boolean;
  reportsFollowers: boolean;
}

/**
 * What a platform shares. Read straight from the registry, not through
 * `getCapabilities`, which throws for a social platform with no entry
 * (`google_business`): such a platform reports nothing.
 */
export function reportsOf(platform: string): {
  reportsViews: boolean;
  reportsReach: boolean;
  reportsFollowers: boolean;
} {
  const caps = PLATFORM_CAPABILITIES[platform as SupportedPlatform];
  return {
    reportsViews: caps?.hasImpressions ?? false,
    reportsReach: caps?.hasReach ?? false,
    reportsFollowers: caps?.hasFollowerCount ?? false,
  };
}

export function freshnessOf(
  channels: FreshnessChannel[],
  rows: SyncStateRow[],
  now: Date,
): ChannelFreshness[] {
  const byChannel = new Map(rows.map((r) => [r.channelId, r]));
  return channels.map((c) => {
    const r = byChannel.get(c.id);
    const base = {
      channelId: c.id,
      isActive: c.isActive,
      connectionStatus: c.connectionStatus,
      ...reportsOf(c.platform),
    };
    if (!r) {
      return {
        ...base,
        lastSyncedAt: null,
        failing: false,
        backfill: 'pending' as const,
      };
    }
    const times = [r.lastProfileSyncAt, r.lastPostsSyncAt]
      .filter((d): d is Date => d !== null)
      .map((d) => new Date(d).getTime());
    return {
      ...base,
      lastSyncedAt: times.length
        ? new Date(Math.max(...times)).toISOString()
        : null,
      failing:
        r.consecutiveFailures >= FAILING_AFTER ||
        (r.pausedUntil !== null && new Date(r.pausedUntil) > now),
      backfill: r.initialBackfillStatus,
    };
  });
}
