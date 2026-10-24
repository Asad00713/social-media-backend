import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import {
  calendarItemLinks,
  externalCalendarEvents,
  externalCalendars,
} from '../../drizzle/schema/calendar-sync.schema';

// Calendar channel platforms whose events we mirror.
const CALENDAR_PLATFORMS = ['google_calendar', 'outlook_calendar'] as const;

// Fallback duration when a provider gave us a start but no end.
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;

/**
 * Read-only external calendar event as served to the calendar UI.
 */
export interface ExternalEventDto {
  id: string;
  provider: 'google' | 'outlook';
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  htmlLink?: string;
  /** `external_calendars.id`; null only until the connection's next sync. */
  calendarId: string | null;
  /** The calendar's name, or the connection's account name before the sync. */
  calendarName: string;
  calendarColor: string | null;
  accountEmail: string | null;
  attendeeCount: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same cap as the calendar posts endpoint. */
const MAX_CALENDAR_SPAN_DAYS = 100;

/**
 * ExternalEventsService — read side of the external import.
 *
 * Serves the events mirrored by {@link CalendarPullSyncService} into
 * `external_calendar_events` so the unified calendar view can render the user's
 * OTHER calendar entries alongside scheduled posts. Read-only: nothing here
 * writes to a provider.
 */
@Injectable()
export class ExternalEventsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * External events of a workspace's connected calendars that OVERLAP the
   * `[fromISO, toISO]` window, oldest start first.
   *
   * Overlap (not containment) so a multi-day/all-day event that starts before
   * the window still shows up inside it.
   *
   * Rows that a `calendar_item_links` row claims are excluded at READ time. A
   * post's own calendar event is already rendered as a post card, and there is a
   * narrow connect-time race in which the delta stream can observe an event we
   * just wrote BEFORE its link row commits — importing it as "external". This
   * filter guarantees such a raced (or otherwise stale) row can never surface as
   * a duplicate card, whatever the pull service happened to persist.
   *
   * All-day events keep `startsAt` at UTC midnight of their calendar date; no
   * zone conversion is applied here.
   */
  async listExternalEvents(
    workspaceId: string,
    fromISO: string,
    toISO: string,
  ): Promise<ExternalEventDto[]> {
    const from = new Date(fromISO);
    const to = new Date(toISO);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('`from` and `to` must be ISO date strings');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('`from` must be before `to`');
    }
    if (to.getTime() - from.getTime() > MAX_CALENDAR_SPAN_DAYS * DAY_MS) {
      throw new BadRequestException(
        `The calendar range is limited to ${MAX_CALENDAR_SPAN_DAYS} days`,
      );
    }

    const rows = await this.db
      .select({
        id: externalCalendarEvents.id,
        title: externalCalendarEvents.title,
        startsAt: externalCalendarEvents.startsAt,
        endsAt: externalCalendarEvents.endsAt,
        isAllDay: externalCalendarEvents.isAllDay,
        htmlLink: externalCalendarEvents.htmlLink,
        platform: socialMediaChannels.platform,
        channelAccountName: socialMediaChannels.accountName,
        calendarId: externalCalendarEvents.calendarId,
        attendeeCount: externalCalendarEvents.attendeeCount,
        calendarName: externalCalendars.name,
        calendarColor: externalCalendars.color,
        accountEmail: externalCalendars.accountEmail,
      })
      .from(externalCalendarEvents)
      .innerJoin(
        socialMediaChannels,
        eq(externalCalendarEvents.channelId, socialMediaChannels.id),
      )
      // Events imported before 0044 have no calendar row yet: left join.
      .leftJoin(
        externalCalendars,
        eq(externalCalendarEvents.calendarId, externalCalendars.id),
      )
      // Anti-join against the link table (index-backed by `cpl_channel_event_ix`):
      // an event WE wrote for a post is never an "external" event, even if a
      // raced delta managed to cache it as one.
      .leftJoin(
        calendarItemLinks,
        and(
          eq(calendarItemLinks.channelId, externalCalendarEvents.channelId),
          eq(
            calendarItemLinks.externalEventId,
            externalCalendarEvents.externalEventId,
          ),
        ),
      )
      .where(
        and(
          eq(externalCalendarEvents.workspaceId, workspaceId),
          inArray(socialMediaChannels.platform, [...CALENDAR_PLATFORMS]),
          eq(socialMediaChannels.isActive, true),
          // The anti-join half: keep only the rows with NO matching link row.
          isNull(calendarItemLinks.id),
          // Time-range overlap. Rows with a NULL start are excluded (a `lte`
          // against NULL is never true), which is what we want — they cannot be
          // placed on the grid.
          lte(externalCalendarEvents.startsAt, to),
          or(
            gte(externalCalendarEvents.endsAt, from),
            and(
              isNull(externalCalendarEvents.endsAt),
              gte(externalCalendarEvents.startsAt, from),
            ),
          ),
        ),
      )
      .orderBy(asc(externalCalendarEvents.startsAt));

    return rows
      .filter((row): row is typeof row & { startsAt: Date } => !!row.startsAt)
      .map((row) => ({
        id: row.id,
        provider: row.platform === 'google_calendar' ? 'google' : 'outlook',
        title: row.title ?? '',
        startsAt: row.startsAt.toISOString(),
        endsAt: (
          row.endsAt ??
          new Date(row.startsAt.getTime() + DEFAULT_EVENT_DURATION_MS)
        ).toISOString(),
        isAllDay: row.isAllDay,
        htmlLink: row.htmlLink ?? undefined,
        calendarId: row.calendarId ?? null,
        calendarName: row.calendarName ?? row.channelAccountName ?? '',
        calendarColor: row.calendarColor ?? null,
        accountEmail: row.accountEmail ?? null,
        attendeeCount: row.attendeeCount ?? null,
      }));
  }
}
