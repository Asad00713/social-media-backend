import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  customWindow,
  isoDate,
  spanDays,
  utcToday,
  windowOf,
} from '../../../post-performance/period';
import { localDateOf } from '../../../planner/lib/workspace-time';
import { parseIsoDate, type ResolvedPeriod } from '../../lib/query';

/** The longest range a report can cover: one quarter, 92 days. */
export const MAX_REPORT_DAYS = 92;

export const REPORT_PERIODS = [
  'last_7_days',
  'last_30_days',
  'last_month',
  'last_quarter',
  'custom',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export type ReportPeriodInput = {
  period: ReportPeriod;
  customFrom: string | null;
  customTo: string | null;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The window a report covers, as the Insights page would build it. Rollup days
 * are UTC days, so a month or quarter that the workspace zone has already
 * closed is cut at UTC yesterday: today's rollup is still being written.
 */
export function resolveReportPeriod(
  p: ReportPeriodInput,
  timeZone: string,
  now: Date,
): ResolvedPeriod {
  switch (p.period) {
    case 'last_7_days':
      return { days: 7, window: windowOf(utcToday(now), 7) };
    case 'last_30_days':
      return { days: 30, window: windowOf(utcToday(now), 30) };
    case 'custom': {
      const from = p.customFrom as string;
      const to = p.customTo as string;
      return { days: spanDays(from, to), window: customWindow(from, to) };
    }
    case 'last_month':
    case 'last_quarter': {
      const [year, month] = localDateOf(now, timeZone).split('-').map(Number);
      const monthsBack = p.period === 'last_month' ? 1 : 3;
      // First day of the month or quarter that contains the local date.
      const currentStart =
        p.period === 'last_month'
          ? `${year}-${pad2(month)}-01`
          : `${year}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
      const [startYear, startMonth] = currentStart.split('-').map(Number);
      const index = startYear * 12 + (startMonth - 1) - monthsBack;
      const from = `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}-01`;
      const yesterday = addDays(isoDate(utcToday(now)), -1);
      const closed = addDays(currentStart, -1);
      const to = closed < yesterday ? closed : yesterday;
      return { days: spanDays(from, to), window: customWindow(from, to) };
    }
  }
}

/**
 * A fixed range must be real dates, in order, end no later than UTC yesterday
 * and span at most MAX_REPORT_DAYS. Throws 400 with the first rule broken.
 */
export function assertCustomRange(
  from: string | null,
  to: string | null,
  now: Date,
): void {
  if (!from || !to) {
    throw new BadRequestException(
      'A custom range needs customFrom and customTo',
    );
  }
  let start: number;
  let end: number;
  try {
    start = parseIsoDate(from, 'customFrom');
    end = parseIsoDate(to, 'customTo');
  } catch {
    throw new BadRequestException(
      'customFrom and customTo must be dates, YYYY-MM-DD',
    );
  }
  if (start > end) {
    throw new BadRequestException('customFrom must be on or before customTo');
  }
  if (to > addDays(isoDate(utcToday(now)), -1)) {
    throw new BadRequestException('customTo must be yesterday or earlier');
  }
  if (spanDays(from, to) > MAX_REPORT_DAYS) {
    throw new BadRequestException(
      `A report range can be at most ${MAX_REPORT_DAYS} days`,
    );
  }
}
