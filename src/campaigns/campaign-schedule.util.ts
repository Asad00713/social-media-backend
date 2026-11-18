import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';
import { wallClockToUtc } from '../common/utils/wall-clock';

export interface SlotSchedule {
  date: string; // yyyy-MM-dd
  time: string; // HH:mm
  scheduledAt: Date;
}

export interface SlotKey {
  date: string;
  time: string;
}

function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

export function computeSlotSchedule(
  schedule: CampaignScheduleJson,
  slots: SlotKey[],
  now: Date,
): { due: SlotSchedule[]; pastDue: SlotKey[] } {
  const due: SlotSchedule[] = [];
  const pastDue: SlotKey[] = [];

  // Bulk & drip share the same per-slot logic now: each slot has an explicit
  // (date, time); we exclude blackout/weekend and split due vs past-due.
  // Evergreen has no endDate bound here; treat like drip within the window.
  const blackout = new Set(schedule.blackoutDates ?? []);
  const skipWeekends = schedule.type === 'bulk' && schedule.skipWeekends;

  for (const slot of slots) {
    if (blackout.has(slot.date)) continue; // excluded, not counted past-due
    if (skipWeekends && isWeekend(slot.date)) continue;

    const at = wallClockToUtc(slot.date, slot.time, schedule.timezone);
    if (!at) continue;

    if (at.getTime() >= now.getTime()) {
      due.push({ date: slot.date, time: slot.time, scheduledAt: at });
    } else {
      pastDue.push({ date: slot.date, time: slot.time });
    }
  }

  return { due, pastDue };
}
