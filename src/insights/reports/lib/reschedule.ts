import { and, eq, isNotNull } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { insightReports } from '../../../drizzle/schema/insight-reports.schema';
import { nextRunAt } from './next-run';

/**
 * The workspace changed its time zone: every scheduled report's next send is
 * recomputed from `now` in the new zone, so "Monday 9:00" stays 9:00 on the
 * wall clock the owner now keeps. Reports without a schedule are not touched.
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
    })
    .from(insightReports)
    .where(
      and(
        eq(insightReports.workspaceId, workspaceId),
        isNotNull(insightReports.cadence),
      ),
    );
  for (const r of rows) {
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
          now,
        ),
      })
      .where(eq(insightReports.id, r.id));
  }
  return rows.length;
}
