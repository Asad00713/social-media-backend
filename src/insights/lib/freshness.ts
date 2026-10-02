/** Failed syncs in a row before a channel counts as failing. */
export const FAILING_AFTER = 3;

export interface SyncStateRow {
  channelId: number;
  lastProfileSyncAt: Date | null;
  lastPostsSyncAt: Date | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
}

export interface ChannelFreshness {
  channelId: number;
  /** The later of the profile and posts syncs; null when never synced. */
  lastSyncedAt: string | null;
  failing: boolean;
}

export function freshnessOf(
  channelIds: number[],
  rows: SyncStateRow[],
  now: Date,
): ChannelFreshness[] {
  const byChannel = new Map(rows.map((r) => [r.channelId, r]));
  return channelIds.map((channelId) => {
    const r = byChannel.get(channelId);
    if (!r) return { channelId, lastSyncedAt: null, failing: false };
    const times = [r.lastProfileSyncAt, r.lastPostsSyncAt]
      .filter((d): d is Date => d !== null)
      .map((d) => new Date(d).getTime());
    return {
      channelId,
      lastSyncedAt: times.length
        ? new Date(Math.max(...times)).toISOString()
        : null,
      failing:
        r.consecutiveFailures >= FAILING_AFTER ||
        (r.pausedUntil !== null && new Date(r.pausedUntil) > now),
    };
  });
}
