import { BadRequestException } from '@nestjs/common';
import { registerDecorator, type ValidationOptions } from 'class-validator';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Most days `to` may lie after `from` (inclusive span of 101 dates). */
export const MAX_NOTE_RANGE_DAYS = 100;

/** Epoch ms of a yyyy-MM-dd calendar date, or null when it is not a real day. */
function parseCalendarDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DATE_PATTERN.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 over to March: the round trip exposes it.
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

/** True for a real calendar day written yyyy-MM-dd (`2026-02-30` is not). */
export function isCalendarDate(value: unknown): value is string {
  return parseCalendarDate(value) !== null;
}

/** class-validator decorator: a real calendar day written yyyy-MM-dd. */
export function IsCalendarDate(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid calendar date (yyyy-MM-dd)`,
        ...options,
      },
      validator: { validate: (value: unknown) => isCalendarDate(value) },
    });
}

/** 400 unless `from` <= `to` and `to` is at most 100 days after `from`. */
export function assertDateRange(from: string, to: string): void {
  const a = parseCalendarDate(from);
  const b = parseCalendarDate(to);
  if (a === null || b === null) {
    throw new BadRequestException('from and to must be valid calendar dates');
  }
  if (a > b) {
    throw new BadRequestException('from must not be after to');
  }
  if ((b - a) / DAY_MS > MAX_NOTE_RANGE_DAYS) {
    throw new BadRequestException(
      `The notes range is limited to ${MAX_NOTE_RANGE_DAYS} days`,
    );
  }
}
