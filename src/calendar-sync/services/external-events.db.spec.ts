import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { ExternalCalendarsService } from './external-calendars.service';
import { ExternalEventsService } from './external-events.service';

const MIGRATION = '0044_external_calendars.sql';

async function seed(client: PoolClient) {
  const tag = Math.random().toString(36).slice(2, 8);
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'u') RETURNING id`,
    [`u-${tag}@example.test`],
  );
  const userId = u.rows[0].id;
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('w', $1, $2) RETURNING id`,
    [`w-${tag}`, userId],
  );
  const workspaceId = w.rows[0].id;
  const c = await client.query<{ id: number }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
     VALUES ($1, 'google_calendar', 'calendar', $2, 'Connection', 'x', $3) RETURNING id`,
    [workspaceId, `acct-${tag}`, userId],
  );
  const channelId = Number(c.rows[0].id);
  const cal = async (pid: string, name: string, isPrimary: boolean) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO external_calendars
           (workspace_id, channel_id, provider_calendar_id, name, color, is_primary, account_email)
         VALUES ($1, $2, $3, $5, '#112233', $4, 'a@example.test') RETURNING id`,
        [workspaceId, channelId, pid, isPrimary, name],
      )
    ).rows[0].id;
  const ev = (eventId: string, calendarId: string | null, pid: string) =>
    client.query(
      `INSERT INTO external_calendar_events
         (workspace_id, channel_id, provider, external_calendar_id, external_event_id, calendar_id, title, starts_at, ends_at, attendee_count)
       VALUES ($1, $2, 'google', $3, $4::varchar, $5, $4::text, '2026-03-02 09:00', '2026-03-02 10:00', 3)`,
      [workspaceId, channelId, pid, eventId, calendarId],
    );
  const link = async (eventId: string) => {
    const p = await client.query<{ id: string }>(
      `INSERT INTO posts (workspace_id, created_by_id, status, content, targets)
       VALUES ($1, $2, 'scheduled', 'x', '[]'::jsonb) RETURNING id`,
      [workspaceId, userId],
    );
    await client.query(
      `INSERT INTO calendar_item_links (workspace_id, channel_id, provider, post_id, external_event_id)
       VALUES ($1, $2, 'google', $3, $4)`,
      [workspaceId, channelId, p.rows[0].id, eventId],
    );
  };
  const deactivate = () =>
    client.query(
      `UPDATE social_media_channels SET is_active = false WHERE id = $1`,
      [channelId],
    );
  return { client, workspaceId, channelId, cal, ev, link, deactivate };
}

const range = ['2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'] as const;

describeDb('ExternalEventsService against Postgres', () => {
  const run = (
    fn: (
      svc: ExternalEventsService,
      s: Awaited<ReturnType<typeof seed>>,
      db: DbType,
    ) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      await fn(new ExternalEventsService(db as never), await seed(client), db);
    });

  it('returns events of a non-primary calendar, each with its own calendar fields', () =>
    run(async (svc, s) => {
      const primary = await s.cal('primary-id', 'Work', true);
      const other = await s.cal('other-id', 'Birthdays', false);
      await s.ev('a', primary, 'primary-id');
      await s.ev('b', other, 'other-id');
      const out = await svc.listExternalEvents(s.workspaceId, ...range);
      const byTitle = new Map(out.map((e) => [e.title, e]));
      expect(byTitle.get('a')).toMatchObject({
        calendarId: primary,
        calendarName: 'Work',
        calendarColor: '#112233',
        accountEmail: 'a@example.test',
        attendeeCount: 3,
      });
      expect(byTitle.get('b')).toMatchObject({
        calendarId: other,
        calendarName: 'Birthdays',
      });
    }));

  it('serves an unassigned row under the connection name', () =>
    run(async (svc, s) => {
      await s.ev('legacy', null, 'primary-id');
      const [dto] = await svc.listExternalEvents(s.workspaceId, ...range);
      expect(dto).toMatchObject({
        calendarId: null,
        calendarName: 'Connection',
        accountEmail: null,
      });
    }));

  it('still excludes an event that calendar_item_links claims', () =>
    run(async (svc, s) => {
      const primary = await s.cal('primary-id', 'Work', true);
      await s.ev('ours', primary, 'primary-id');
      await s.ev('theirs', primary, 'primary-id');
      await s.link('ours');
      const out = await svc.listExternalEvents(s.workspaceId, ...range);
      expect(out.map((e) => e.title)).toEqual(['theirs']);
    }));

  it('lists calendars with provider and channelId, primary first', () =>
    run(async (_svc, s, db) => {
      const other = await s.cal('other-id', 'Birthdays', false);
      const primary = await s.cal('primary-id', 'Work', true);
      const svc = new ExternalCalendarsService(db, {} as never, {} as never);
      const out = await svc.listCalendarDtos(s.workspaceId);
      expect(out.map((c) => c.id)).toEqual([primary, other]);
      expect(out[0]).toMatchObject({
        provider: 'google',
        channelId: s.channelId,
        accountEmail: 'a@example.test',
        color: '#112233',
        isPrimary: true,
      });
    }));

  it('leaves an inactive channel calendars and events out of both lists', () =>
    run(async (svc, s, db) => {
      const cal = await s.cal('primary-id', 'Work', true);
      await s.ev('a', cal, 'primary-id');
      const calendars = new ExternalCalendarsService(
        db,
        {} as never,
        {} as never,
      );
      expect(await calendars.listCalendarDtos(s.workspaceId)).toHaveLength(1);
      expect(
        await svc.listExternalEvents(s.workspaceId, ...range),
      ).toHaveLength(1);

      await s.deactivate();

      expect(await calendars.listCalendarDtos(s.workspaceId)).toEqual([]);
      expect(await svc.listExternalEvents(s.workspaceId, ...range)).toEqual([]);
    }));

  it("never returns another workspace's calendars or events", () =>
    run(async (svc, s, db) => {
      const mine = await s.cal('primary-id', 'Work', true);
      await s.ev('mine', mine, 'primary-id');
      const other = await seed(s.client);
      const theirs = await other.cal('their-id', 'Theirs', true);
      await other.ev('theirs', theirs, 'their-id');

      const calendars = new ExternalCalendarsService(
        db,
        {} as never,
        {} as never,
      );
      expect(
        (await calendars.listCalendarDtos(s.workspaceId)).map((c) => c.id),
      ).toEqual([mine]);
      expect(
        (await svc.listExternalEvents(s.workspaceId, ...range)).map(
          (e) => e.title,
        ),
      ).toEqual(['mine']);
    }));
});
