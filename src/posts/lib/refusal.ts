import { BadRequestException } from '@nestjs/common';

export type RefusalCode =
  | 'POST_ALREADY_PUBLISHED'
  | 'POST_PARTLY_PUBLISHED'
  | 'SCHEDULE_IN_PAST';

/**
 * A 400 whose body keeps the standard Nest shape `{ statusCode, message,
 * error }` and adds a machine-readable `code`. Nest sends an object response
 * as-is, so the standard fields must be spelled out.
 */
export function refusal(message: string, code: RefusalCode) {
  return new BadRequestException({
    statusCode: 400,
    message,
    error: 'Bad Request',
    code,
  });
}

/** The one "past" rule for scheduling: strictly before now. */
export function isScheduleInPast(scheduledAt: Date | string): boolean {
  return new Date(scheduledAt).getTime() < Date.now();
}

/** Throws SCHEDULE_IN_PAST. Call before any write, cancel or history entry. */
export function assertNotInPast(scheduledAt: Date | string): void {
  if (isScheduleInPast(scheduledAt)) throw scheduleInPastRefusal();
}

export function scheduleInPastRefusal() {
  return refusal('Cannot schedule a post in the past', 'SCHEDULE_IN_PAST');
}
