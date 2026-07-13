import { PreconditionFailedException } from '@nestjs/common';

/**
 * Thrown by GoogleCalendarService/OutlookCalendarService when an `If-Match`
 * guarded event update is rejected by the provider with **412 Precondition
 * Failed** — i.e. the event changed remotely since the etag/changeKey we hold.
 *
 * Calendar-sync catches this to re-fetch the event, re-resolve the conflict and
 * apply the winner exactly once (see `CalendarPullSyncService`). Extends Nest's
 * `PreconditionFailedException` so any HTTP caller still gets a 4xx rather than
 * a 500.
 */
export class CalendarPreconditionFailedError extends PreconditionFailedException {
  constructor(
    public readonly provider: 'google' | 'outlook',
    public readonly eventId: string,
  ) {
    super(
      `Calendar event ${eventId} changed remotely (${provider}): If-Match precondition failed`,
    );
  }
}
