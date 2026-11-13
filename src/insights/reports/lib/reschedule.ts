import { and, eq, isNotNull } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { insightReports } from '../../../drizzle/schema/insight-reports.schema';
import { nextRunAt } from './next-run';

/**
 * A report sent less than this long ago has had its slot. The cadence is at
 * least 7 days and the widest gap between two zones' UTC offsets is 26 hours,
 * so waiting 27 hours after a send never skips a real slot.
 */
const SENT_SLOT_HOLD_MS = 27 * 60 * 60 * 1000;

/**
 * The workspace changed its time zone: every scheduled report's next send is
 * recomputed from `now` in the new zone, so "Monday 9:00" stays 9:00 on the
 * wall clock the owner now keeps. A report already sent for this period is not
 * sent again: moving west can put today's slot back in the future. Reports
 * without a schedule are not touched.
 * Not an edit, so `updated_at` and `updated_by` stay. Returns how many moved.
 */
export async function rescheduleWorkspaceReports(
  db: DbType,
  workspaceId: string,
  timeZone: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({
      id: insightReports.id,
      cadence: insightReports.cadence,
      weekday: insightReports.weekday,
      sendMinute: insightReports.sendMinute,
      lastSentAt: insightReports.lastSentAt,
    })
    .from(insightReports)
    .where(
      and(
        eq(insightReports.workspaceId, workspaceId),
        isNotNull(insightReports.cadence),
      ),
    );
  for (const r of rows) {
    const held = r.lastSentAt
      ? r.lastSentAt.getTime() + SENT_SLOT_HOLD_MS
      : -Infinity;
    const after = new Date(Math.max(now.getTime(), held));
    await db
      .update(insightReports)
      .set({
        nextRunAt: nextRunAt(
          {
            cadence: r.cadence as 'weekly' | 'monthly',
            weekday: r.weekday,
            // The schedule CHECK sets send_minute whenever cadence is set.
            sendMinute: r.sendMinute as number,
          },
          timeZone,
          after,
        ),
      })
      .where(eq(insightReports.id, r.id));
  }
  return rows.length;
}
