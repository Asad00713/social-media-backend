import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  externalCalendarEvents,
  externalCalendars,
  type ExternalCalendarRow,
} from '../../drizzle/schema/calendar-sync.schema';
import {
  GoogleCalendarService,
  type Calendar,
} from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';

/** Most calendars one connection may hold; extra ones are never created. */
export const MAX_CALENDARS_PER_CONNECTION = 25;

export type { ExternalCalendarRow };

interface CalendarChannelRef {
  id: number;
  workspaceId: string;
  platform: string;
}

/** What a provider hands back for "every calendar of this account". */
interface CalendarListResult {
  calendars: Calendar[];
  /** False when the walk stopped with pages still pending. */
  complete: boolean;
}

/**
 * Discovers every calendar a Google/Outlook connection can see and keeps the
 * `external_calendars` rows in step with the provider. Pulling a calendar's
 * events is the pull service's job; this class owns only the list.
 *
 * Deleting a row cascades its events, so a delete needs proof the calendar is
 * gone: only a COMPLETE, successful, non-empty list may delete. A failed
 * request, a page-capped (partial) list or an empty list keeps every row.
 */
@Injectable()
export class ExternalCalendarsService {
  private readonly logger = new Logger(ExternalCalendarsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly outlookCalendarService: OutlookCalendarService,
  ) {}

  /**
   * Mirror the provider's calendar list into `external_calendars`.
   * `primaryIsNew` is true only on the call that first creates the primary row.
   * Never throws for a provider failure: the existing rows come back unchanged.
   */
  async syncCalendarList(
    channel: CalendarChannelRef,
    accessToken: string,
  ): Promise<{ calendars: ExternalCalendarRow[]; primaryIsNew: boolean }> {
    const existing = await this.db
      .select()
      .from(externalCalendars)
      .where(eq(externalCalendars.channelId, channel.id));

    const isGoogle = channel.platform === 'google_calendar';
    let listed: CalendarListResult;
    try {
      listed = isGoogle
        ? await this.googleCalendarService.listCalendarsComplete(accessToken)
        : await this.outlookCalendarService.listCalendarsComplete(accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Calendar list failed for channel ${channel.id}: ${message} - keeping ${existing.length} existing calendar(s)`,
      );
      return { calendars: sortRows(existing), primaryIsNew: false };
    }

    const hasFlaggedPrimary = listed.calendars.some((c) => c.primary);
    const ordered = primaryFirst(listed.calendars);
    const accountEmail = await this.resolveAccountEmail(
      isGoogle,
      ordered,
      accessToken,
    );

    // Only a complete, non-empty list proves a calendar is gone.
    const canDelete = listed.complete && ordered.length > 0;
    const listedIds = new Set(ordered.map((c) => c.id));
    const gone = canDelete
      ? existing.filter((row) => !listedIds.has(row.providerCalendarId))
      : [];
    if (!listed.complete) {
      this.logger.warn(
        `Calendar list for channel ${channel.id} is incomplete - not deleting anything this run`,
      );
    }
    if (gone.length > 0) {
      await this.db.delete(externalCalendars).where(
        inArray(
          externalCalendars.id,
          gone.map((row) => row.id),
        ),
      );
    }

    const goneIds = new Set(gone.map((row) => row.id));
    const kept = new Map(
      existing
        .filter((row) => !goneIds.has(row.id))
        .map((row) => [row.providerCalendarId, row] as const),
    );
    // Rows already held count against the cap, even ones the provider has
    // reordered past it; only rows the provider dropped free a slot.
    let slots = Math.max(0, MAX_CALENDARS_PER_CONNECTION - kept.size);
    const rows = new Map(kept);
    let primaryIsNew = false;
    let needsReselect = false;

    for (const [index, cal] of ordered.entries()) {
      const wanted = {
        name: cal.summary || 'Calendar',
        color: (cal.backgroundColor ?? '').slice(0, 16) || null,
        // Same fallback as getPrimaryCalendar: no flag means the first one.
        isPrimary: hasFlaggedPrimary ? Boolean(cal.primary) : index === 0,
        accountEmail,
      };
      const current = kept.get(cal.id);

      if (current) {
        if (
          current.name !== wanted.name ||
          current.color !== wanted.color ||
          current.isPrimary !== wanted.isPrimary ||
          current.accountEmail !== wanted.accountEmail
        ) {
          const updatedAt = new Date();
          await this.db
            .update(externalCalendars)
            .set({ ...wanted, updatedAt })
            .where(eq(externalCalendars.id, current.id));
          rows.set(cal.id, { ...current, ...wanted, updatedAt });
        }
        continue;
      }

      if (slots <= 0) continue; // beyond the cap: never created
      slots -= 1;
      const [created] = await this.db
        .insert(externalCalendars)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          providerCalendarId: cal.id,
          ...wanted,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        needsReselect = true; // a concurrent sync created it first
        continue;
      }
      rows.set(cal.id, created);
      if (created.isPrimary) primaryIsNew = true;
    }

    if (needsReselect) {
      const all = await this.db
        .select()
        .from(externalCalendars)
        .where(eq(externalCalendars.channelId, channel.id));
      return { calendars: sortRows(all), primaryIsNew };
    }
    return { calendars: sortRows([...rows.values()]), primaryIsNew };
  }

  async listForWorkspace(workspaceId: string): Promise<ExternalCalendarRow[]> {
    return this.db
      .select()
      .from(externalCalendars)
      .where(eq(externalCalendars.workspaceId, workspaceId))
      .orderBy(desc(externalCalendars.isPrimary), asc(externalCalendars.name));
  }

  /**
   * Events imported before 0044 have no `calendar_id`: they all came from the
   * primary calendar, so the new primary row claims them. Touches only this
   * channel's rows of that provider calendar that are still unassigned.
   */
  async claimUnassignedEvents(
    channelId: number,
    providerCalendarId: string,
    calendarRowId: string,
  ): Promise<void> {
    await this.db
      .update(externalCalendarEvents)
      .set({ calendarId: calendarRowId })
      .where(
        and(
          eq(externalCalendarEvents.channelId, channelId),
          eq(externalCalendarEvents.externalCalendarId, providerCalendarId),
          isNull(externalCalendarEvents.calendarId),
        ),
      );
  }

  /**
   * Google names the primary calendar by the account's address; Outlook needs
   * a Graph lookup. A failed lookup only leaves the email empty.
   */
  private async resolveAccountEmail(
    isGoogle: boolean,
    ordered: Calendar[],
    accessToken: string,
  ): Promise<string | null> {
    if (isGoogle) {
      const primary = ordered.find((c) => c.primary) ?? ordered[0];
      return primary?.id.includes('@') ? primary.id : null;
    }
    try {
      return await this.outlookCalendarService.getAccountEmail(accessToken);
    } catch {
      return null;
    }
  }
}

/** The primary calendar first (the provider's flag), the rest in list order. */
function primaryFirst(calendars: Calendar[]): Calendar[] {
  const primary = calendars.find((c) => c.primary);
  if (!primary) return [...calendars];
  return [primary, ...calendars.filter((c) => c !== primary)];
}

function sortRows(rows: ExternalCalendarRow[]): ExternalCalendarRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name),
  );
}
