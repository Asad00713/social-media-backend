/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- loosely typed harness doubles */
// `CalendarPullSyncService` uses the module-level `db` singleton, so the module
// is replaced by a proxy that forwards to the rollback-transaction db.
let mockDb: any;
jest.mock('../../drizzle/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => mockDb[prop] }),
}));

import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { CalendarPullSyncService } from './calendar-pull-sync.service';

const MIGRATION = '0044_external_calendars.sql';

interface Internals {
  upsertExternalEvent(
    channel: { id: number; workspaceId: string },
    provider: 'google',
    calendarId: string,
    event: Record<string, unknown>,
    calendarRowId: string | null,
  ): Promise<void>;
}

describeDb('CalendarPullSyncService.upsertExternalEvent', () => {
  it('keeps the owning calendar when a later pull could not resolve it', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      mockDb = db;
      const u = await client.query(
        `INSERT INTO users (email, name) VALUES ('u-upsert@example.test', 'u') RETURNING id`,
      );
      const w = await client.query(
        `INSERT INTO workspace (name, slug, owner_id) VALUES ('w', 'w-upsert', $1) RETURNING id`,
        [u.rows[0].id],
      );
      const ch = await client.query(
        `INSERT INTO social_media_channels
           (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
         VALUES ($1, 'google_calendar', 'calendar', 'acct-upsert', 'acct', 'x', $2) RETURNING id`,
        [w.rows[0].id, u.rows[0].id],
      );
      const cal = await client.query(
        `INSERT INTO external_calendars (workspace_id, channel_id, provider_calendar_id, name)
         VALUES ($1, $2, 'primary-id', 'P') RETURNING id`,
        [w.rows[0].id, ch.rows[0].id],
      );
      const channel = {
        id: Number(ch.rows[0].id),
        workspaceId: w.rows[0].id as string,
      };
      const event = {
        externalEventId: 'e1',
        calendarId: 'primary-id',
        title: 'T',
        startsAt: new Date('2026-11-01T10:00:00Z'),
        endsAt: new Date('2026-11-01T11:00:00Z'),
        isAllDay: false,
        externalUpdatedAt: null,
        raw: {},
      };
      const svc = Object.create(
        CalendarPullSyncService.prototype,
      ) as unknown as Internals;

      await svc.upsertExternalEvent(
        channel,
        'google',
        'primary-id',
        event,
        cal.rows[0].id,
      );
      // Discovery failed this run: no calendar row id.
      await svc.upsertExternalEvent(
        channel,
        'google',
        'primary-id',
        {
          ...event,
          title: 'T2',
        },
        null,
      );

      const row = await client.query(
        `SELECT calendar_id, title FROM external_calendar_events WHERE external_event_id = 'e1'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].title).toBe('T2');
      expect(row.rows[0].calendar_id).toBe(cal.rows[0].id);
    }));
});
