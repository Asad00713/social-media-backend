import { BadRequestException, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import {
  calendarPostLinks,
  externalCalendarEvents,
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
}

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
  /**
   * External events of a workspace's connected calendars that OVERLAP the
   * `[fromISO, toISO]` window, oldest start first.
   *
   * Overlap (not containment) so a multi-day/all-day event that starts before
   * the window still shows up inside it.
   *
   * Rows that a `calendar_post_links` row claims are excluded at READ time. A
   * post's own calendar event is already rendered as a post card, and there is a
   * narrow connect-time race in which the delta stream can observe an event we
   * just wrote BEFORE its link row commits — importing it as "external". This
   * filter guarantees such a raced (or otherwise stale) row can never surface as
   * a duplicate card, whatever the pull service happened to persist.
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

    const rows = await db
      .select({
        id: externalCalendarEvents.id,
        title: externalCalendarEvents.title,
        startsAt: externalCalendarEvents.startsAt,
        endsAt: externalCalendarEvents.endsAt,
        isAllDay: externalCalendarEvents.isAllDay,
        htmlLink: externalCalendarEvents.htmlLink,
        platform: socialMediaChannels.platform,
      })
      .from(externalCalendarEvents)
      .innerJoin(
        socialMediaChannels,
        eq(externalCalendarEvents.channelId, socialMediaChannels.id),
      )
      // Anti-join against the link table (index-backed by `cpl_channel_event_ix`):
      // an event WE wrote for a post is never an "external" event, even if a
      // raced delta managed to cache it as one.
      .leftJoin(
        calendarPostLinks,
        and(
          eq(calendarPostLinks.channelId, externalCalendarEvents.channelId),
          eq(
            calendarPostLinks.externalEventId,
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
          isNull(calendarPostLinks.id),
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
      }));
  }
}
