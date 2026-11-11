import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { FollowerRow } from '../../post-performance/followers';
import { datesBetween } from '../../post-performance/period';
import type {
  AudienceGrowthChannelDto,
  AudienceGrowthDto,
  GrowthPoint,
} from './audience.dto';

interface GrowthChannel {
  id: number;
  platform: SupportedPlatform;
  accountName: string;
}

/** Sum of the non-null values, or null when there are none. */
function sumOrNull(values: (number | null)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v !== null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * One channel's follower line across the window. Its last count is carried
 * over days the rollup missed. The base is the latest reading before the
 * window (the seed), or, with none, the first reading inside it. A day before
 * any reading, or before the base exists, is null. A drop stays negative.
 */
function channelGrowth(
  channel: GrowthChannel,
  rows: FollowerRow[],
  dates: string[],
  from: string,
): AudienceGrowthChannelDto {
  const readings = rows
    .filter((r) => r.followersAtEndOfDay !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const seed = readings.filter((r) => r.date < from).pop();
  const firstInRange = readings.find((r) => r.date >= from);
  const base =
    seed?.followersAtEndOfDay ?? firstInRange?.followersAtEndOfDay ?? null;

  let i = 0;
  let carried: number | null = null;
  const series: GrowthPoint[] = dates.map((date) => {
    while (i < readings.length && readings[i].date <= date) {
      carried = readings[i++].followersAtEndOfDay;
    }
    return {
      date,
      followers: carried,
      gained: carried !== null && base !== null ? carried - base : null,
    };
  });

  const last = series[series.length - 1];
  return {
    channelId: channel.id,
    platform: channel.platform,
    name: channel.accountName,
    current: last?.followers ?? null,
    change: last?.gained ?? null,
    series,
  };
}

/**
 * Audience growth for a window: one follower series per channel plus a total.
 * A channel that never reported is kept, all null, and adds nothing to the
 * total. Channels come back sorted by change, largest first, nulls last.
 */
export function audienceGrowth(
  rows: FollowerRow[],
  channels: GrowthChannel[],
  window: { from: string; to: string },
): AudienceGrowthDto {
  const dates = datesBetween(window.from, window.to);
  const rowsByChannel = new Map<number, FollowerRow[]>();
  for (const r of rows) {
    const list = rowsByChannel.get(r.channelId);
    if (list) list.push(r);
    else rowsByChannel.set(r.channelId, [r]);
  }

  const perChannel = channels.map((c) =>
    channelGrowth(c, rowsByChannel.get(c.id) ?? [], dates, window.from),
  );

  const totalSeries: GrowthPoint[] = dates.map((date, d) => ({
    date,
    followers: sumOrNull(perChannel.map((c) => c.series[d].followers)),
    gained: sumOrNull(perChannel.map((c) => c.series[d].gained)),
  }));

  const sorted = [...perChannel].sort((a, b) => {
    if (a.change === null && b.change === null)
      return a.channelId - b.channelId;
    if (a.change === null) return 1;
    if (b.change === null) return -1;
    return b.change - a.change || a.channelId - b.channelId;
  });

  return {
    window: { from: window.from, to: window.to },
    total: {
      current: sumOrNull(perChannel.map((c) => c.current)),
      change: sumOrNull(perChannel.map((c) => c.change)),
      series: totalSeries,
    },
    channels: sorted,
  };
}
