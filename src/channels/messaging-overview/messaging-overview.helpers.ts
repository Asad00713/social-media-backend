import type {
  MessagingActivityPointDto,
  MessagingTopChannelDto,
  MessagingChannelMixSliceDto,
} from './dto/messaging-overview-response.dto';

export type MessagingRange = '7d' | '30d' | '90d';

export function rangeToDays(range: MessagingRange): number {
  if (range === '7d') return 7;
  if (range === '90d') return 90;
  return 30;
}

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface DayCountRow {
  date: string;
  count: number | string;
}

/** 0-filled daily series for the last `days` days ending at `today` (inclusive). */
export function buildActivitySeries(
  rows: DayCountRow[],
  days: number,
  today: Date,
): MessagingActivityPointDto[] {
  const byDate = new Map(rows.map((r) => [r.date, Number(r.count)]));
  const out: MessagingActivityPointDto[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ label: formatDayLabel(d), messages: byDate.get(toYmd(d)) ?? 0 });
  }
  return out;
}

export interface TopChannelRow {
  conversationId: string | null;
  count: number | string;
}

export interface ChannelInfo {
  name: string;
  isPrivate: boolean;
}

/** Maps grouped inbox rows to top-channel DTOs, resolving names from the Slack channel map. */
export function mapTopChannels(
  rows: TopChannelRow[],
  channelMap: Map<string, ChannelInfo>,
): MessagingTopChannelDto[] {
  return rows
    .filter((r) => r.conversationId)
    .map((r) => {
      const id = r.conversationId as string;
      const info = channelMap.get(id);
      if (info) {
        return { id, name: info.name, isPrivate: info.isPrivate, messages: Number(r.count) };
      }
      // Slack DM conversation ids start with 'D'.
      if (id.startsWith('D')) {
        return { id, name: 'Direct message', isPrivate: true, messages: Number(r.count) };
      }
      return { id, name: id, isPrivate: false, messages: Number(r.count) };
    });
}

export function buildChannelMix(
  publicCount: number,
  privateCount: number,
  dmCount: number,
): MessagingChannelMixSliceDto[] {
  return [
    { label: 'Public', value: publicCount },
    { label: 'Private', value: privateCount },
    { label: 'DMs', value: dmCount },
  ];
}
