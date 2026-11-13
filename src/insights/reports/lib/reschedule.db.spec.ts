import { seedWorkspace } from '../../../inbox/testing/inbox-db';
import {
  describeDb,
  withRollbackDb,
} from '../../../planner/testing/rollback-db';
import { ReportsRepository } from '../reports.repository';
import { rescheduleWorkspaceReports } from './reschedule';

const NOW = new Date('2026-11-13T00:00:00Z');

function report(workspaceId: string, over: Record<string, unknown> = {}) {
  return {
    workspaceId,
    name: 'Weekly',
    channelIds: [1],
    period: 'last_30_days',
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['totals'],
    ...over,
  };
}

describeDb('rescheduleWorkspaceReports (database)', () => {
  it('moves a weekly Monday 09:00 report from UTC to Karachi', async () => {
    await withRollbackDb(['0064_insight_reports.sql'], async (db, client) => {
      const repo = new ReportsRepository(db);
      const { workspaceId } = await seedWorkspace(client);
      // 09:00 UTC on Monday 2026-11-16.
      const id = await repo.insert(
        report(workspaceId, {
          cadence: 'weekly',
          weekday: 1,
          sendMinute: 540,
          nextRunAt: new Date('2026-11-16T09:00:00Z'),
        }),
      );
      await client.query(
        `UPDATE insight_reports SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
        [id],
      );

      await expect(
        rescheduleWorkspaceReports(db, workspaceId, 'Asia/Karachi', NOW),
      ).resolves.toBe(1);

      const got = await repo.get(workspaceId, id);
      expect(got?.row.nextRunAt).toEqual(new Date('2026-11-16T04:00:00Z'));
      // Not an edit.
      expect(got?.row.updatedAt).toEqual(new Date('2020-01-01T00:00:00Z'));
    });
  });

  it('leaves an unscheduled report, and another workspace, alone', async () => {
    await withRollbackDb(['0064_insight_reports.sql'], async (db, client) => {
      const repo = new ReportsRepository(db);
      const mine = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const slot = new Date('2026-11-16T09:00:00Z');
      const unscheduled = await repo.insert(report(mine.workspaceId));
      const elsewhere = await repo.insert(
        report(other.workspaceId, {
          cadence: 'weekly',
          weekday: 1,
          sendMinute: 540,
          nextRunAt: slot,
        }),
      );

      await expect(
        rescheduleWorkspaceReports(db, mine.workspaceId, 'Asia/Karachi', NOW),
      ).resolves.toBe(0);

      expect(
        (await repo.get(mine.workspaceId, unscheduled))?.row.nextRunAt,
      ).toBeNull();
      expect(
        (await repo.get(other.workspaceId, elsewhere))?.row.nextRunAt,
      ).toEqual(slot);
    });
  });

  describe('a report already sent for this period', () => {
    const LA = 'America/Los_Angeles';

    async function reschedule(
      over: Record<string, unknown>,
      now: Date,
    ): Promise<Date | null | undefined> {
      return withRollbackDb(
        ['0064_insight_reports.sql'],
        async (db, client) => {
          const repo = new ReportsRepository(db);
          const { workspaceId } = await seedWorkspace(client);
          const id = await repo.insert(report(workspaceId, over));
          await rescheduleWorkspaceReports(db, workspaceId, LA, now);
          return (await repo.get(workspaceId, id))?.row.nextRunAt;
        },
      );
    }

    it('weekly: sent Monday 09:00 UTC, switched to Los Angeles at 10:00 UTC, waits for the following Monday', async () => {
      // Without the hold, Monday 09:00 in Los Angeles (17:00 UTC) is still ahead.
      await expect(
        reschedule(
          {
            cadence: 'weekly',
            weekday: 1,
            sendMinute: 540,
            lastSentAt: new Date('2026-11-16T09:00:00Z'),
            nextRunAt: new Date('2026-11-23T09:00:00Z'),
          },
          new Date('2026-11-16T10:00:00Z'),
        ),
      ).resolves.toEqual(new Date('2026-11-23T17:00:00Z'));
    });

    it('monthly: sent on the 1st, switched the same morning, waits for next month', async () => {
      await expect(
        reschedule(
          {
            cadence: 'monthly',
            sendMinute: 540,
            lastSentAt: new Date('2026-12-01T09:00:00Z'),
            nextRunAt: new Date('2027-01-01T09:00:00Z'),
          },
          new Date('2026-12-01T10:00:00Z'),
        ),
      ).resolves.toEqual(new Date('2027-01-01T17:00:00Z'));
    });

    it('holds only after a recent send: a send a week ago leaves the slot due today', async () => {
      await expect(
        reschedule(
          {
            cadence: 'weekly',
            weekday: 1,
            sendMinute: 540,
            lastSentAt: new Date('2026-11-09T09:00:00Z'),
            nextRunAt: new Date('2026-11-16T09:00:00Z'),
          },
          new Date('2026-11-16T10:00:00Z'),
        ),
      ).resolves.toEqual(new Date('2026-11-16T17:00:00Z'));
    });
  });
});
