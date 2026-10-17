import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import type { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import type { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import {
  ExternalCalendarsService,
  MAX_CALENDARS_PER_CONNECTION,
} from './external-calendars.service';

const MIGRATION = '0044_external_calendars.sql';

async function connection(client: PoolClient, tag: string) {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`, tag],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, u.rows[0].id],
  );
  const c = await client.query<{ id: string }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
     VALUES ($1, 'google_calendar', 'calendar', $2, $2, 'x', $3) RETURNING id`,
    [
      w.rows[0].id,
      `acct-${tag}-${Math.random().toString(36).slice(2, 8)}`,
      u.rows[0].id,
    ],
  );
  return {
    workspaceId: w.rows[0].id,
    channel: {
      id: Number(c.rows[0].id),
      workspaceId: w.rows[0].id,
      platform: 'google_calendar',
    },
  };
}

const event = (
  client: PoolClient,
  c: { workspaceId: string; channel: { id: number } },
  eventId: string,
  calendarId: string | null,
  externalCalendarId = 'primary-id',
) =>
  client.query(
    `INSERT INTO external_calendar_events
       (workspace_id, channel_id, provider, external_calendar_id, external_event_id, calendar_id)
     VALUES ($1, $2, 'google', $3, $4, $5)`,
    [c.workspaceId, c.channel.id, externalCalendarId, eventId, calendarId],
  );

describeDb('external_calendars (0044) and ExternalCalendarsService', () => {
  const run = (
    fn: (
      svc: ExternalCalendarsService,
      client: PoolClient,
      list: jest.Mock,
    ) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const list = jest.fn();
      const svc = new ExternalCalendarsService(
        db as never,
        { listCalendarsComplete: list } as unknown as GoogleCalendarService,
        {} as OutlookCalendarService,
      );
      await fn(svc, client, list);
    });

  it('keeps timestamp columns of the events table as they were (new ones are timestamptz)', () =>
    run(async (_svc, client) => {
      const r = await client.query<{ table_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE (table_name = 'external_calendars' AND column_name IN ('created_at','updated_at','last_full_sync_at'))
             OR (table_name = 'external_calendar_events' AND column_name IN ('starts_at','ends_at'))`,
      );
      const byTable = (t: string) => r.rows.filter((x) => x.table_name === t);
      expect(
        byTable('external_calendars').every(
          (x) => x.data_type === 'timestamp with time zone',
        ),
      ).toBe(true);
      expect(
        byTable('external_calendar_events').every(
          (x) => x.data_type === 'timestamp without time zone',
        ),
      ).toBe(true);
    }));

  it('cascades a deleted calendar row to its events only', () =>
    run(async (_svc, client) => {
      const c = await connection(client, 'casc');
      const cals = await client.query<{ id: string }>(
        `INSERT INTO external_calendars (workspace_id, channel_id, provider_calendar_id, name)
         VALUES ($1, $2, 'a', 'A'), ($1, $2, 'b', 'B') RETURNING id`,
        [c.workspaceId, c.channel.id],
      );
      const [a, b] = cals.rows.map((r) => r.id);
      await event(client, c, 'e1', a);
      await event(client, c, 'e2', b);

      await client.query(`DELETE FROM external_calendars WHERE id = $1`, [a]);

      const left = await client.query<{ external_event_id: string }>(
        `SELECT external_event_id FROM external_calendar_events WHERE channel_id = $1`,
        [c.channel.id],
      );
      expect(left.rows.map((r) => r.external_event_id)).toEqual(['e2']);
    }));

  it('rejects a second row for the same (channel, provider calendar)', () =>
    run(async (_svc, client) => {
      const c = await connection(client, 'uniq');
      const ins = () =>
        client.query(
          `INSERT INTO external_calendars (workspace_id, channel_id, provider_calendar_id, name)
           VALUES ($1, $2, 'same', 'S')`,
          [c.workspaceId, c.channel.id],
        );
      await ins();
      await client.query('SAVEPOINT s');
      await expect(ins()).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT s');
    }));

  describe('claimUnassignedEvents', () => {
    it('touches only unassigned rows of that channel and provider calendar', () =>
      run(async (svc, client) => {
        const mine = await connection(client, 'mine');
        const other = await connection(client, 'other');
        const cal = async (c: typeof mine, id: string) =>
          (
            await client.query<{ id: string }>(
              `INSERT INTO external_calendars (workspace_id, channel_id, provider_calendar_id, name)
               VALUES ($1, $2, $3, 'C') RETURNING id`,
              [c.workspaceId, c.channel.id, id],
            )
          ).rows[0].id;
        const primary = await cal(mine, 'primary-id');
        const team = await cal(mine, 'team-id');
        const otherPrimary = await cal(other, 'primary-id');

        await event(client, mine, 'old-1', null); // legacy row: claimed
        await event(client, mine, 'old-2', null);
        await event(client, mine, 'team-null', null, 'team-id'); // other calendar
        await event(client, mine, 'assigned', team); // already assigned
        await event(client, other, 'foreign', null); // another channel

        await svc.claimUnassignedEvents(mine.channel.id, 'primary-id', primary);

        const rows = await client.query<{
          external_event_id: string;
          calendar_id: string | null;
        }>(
          `SELECT external_event_id, calendar_id FROM external_calendar_events`,
        );
        const byId = Object.fromEntries(
          rows.rows.map((r) => [r.external_event_id, r.calendar_id]),
        );
        expect(byId).toEqual({
          'old-1': primary,
          'old-2': primary,
          'team-null': null,
          assigned: team,
          foreign: null,
        });
        expect(otherPrimary).toBeDefined();
      }));
  });

  describe('syncCalendarList against Postgres', () => {
    it('creates the primary first, then removes a vanished calendar with its events', () =>
      run(async (svc, client, list) => {
        const c = await connection(client, 'sync');
        list.mockResolvedValue({
          complete: true,
          calendars: [
            { id: 'team', summary: 'Team' },
            { id: 'me@x.test', summary: 'Me', primary: true },
          ],
        });
        const first = await svc.syncCalendarList(c.channel, 'tok');
        expect(first.primaryIsNew).toBe(true);
        expect(first.calendars.map((r) => r.providerCalendarId)).toEqual([
          'me@x.test',
          'team',
        ]);
        expect(first.calendars[0].accountEmail).toBe('me@x.test');

        const team = first.calendars.find(
          (r) => r.providerCalendarId === 'team',
        );
        await event(client, c, 'team-evt', team!.id, 'team');

        list.mockResolvedValue({
          complete: true,
          calendars: [{ id: 'me@x.test', summary: 'Me', primary: true }],
        });
        const second = await svc.syncCalendarList(c.channel, 'tok');
        expect(second.primaryIsNew).toBe(false);
        expect(second.calendars).toHaveLength(1);
        const events = await client.query(
          `SELECT 1 FROM external_calendar_events WHERE channel_id = $1`,
          [c.channel.id],
        );
        expect(events.rowCount).toBe(0);
      }));

    it('keeps rows and their events when the list fails or is incomplete', () =>
      run(async (svc, client, list) => {
        const c = await connection(client, 'keep');
        list.mockResolvedValue({
          complete: true,
          calendars: [
            { id: 'me@x.test', summary: 'Me', primary: true },
            { id: 'team', summary: 'Team' },
          ],
        });
        await svc.syncCalendarList(c.channel, 'tok');

        list.mockRejectedValue(new Error('503'));
        await svc.syncCalendarList(c.channel, 'tok');
        list.mockResolvedValue({
          complete: false,
          calendars: [{ id: 'me@x.test', summary: 'Me', primary: true }],
        });
        const after = await svc.syncCalendarList(c.channel, 'tok');

        expect(after.calendars).toHaveLength(2);
      }));

    it('caps new rows, and keeps an existing row the provider moved past the cap', () =>
      run(async (svc, client, list) => {
        const c = await connection(client, 'cap');
        const mk = (prefix: string, n: number) =>
          Array.from({ length: n }, (_, i) => ({
            id: `${prefix}${i}`,
            summary: `${prefix}${i}`,
          }));
        list.mockResolvedValue({ complete: true, calendars: mk('old', 25) });
        const seeded = await svc.syncCalendarList(c.channel, 'tok');
        expect(seeded.calendars).toHaveLength(MAX_CALENDARS_PER_CONNECTION);

        list.mockResolvedValue({
          complete: true,
          calendars: [...mk('new', 30), ...mk('old', 25)],
        });
        const after = await svc.syncCalendarList(c.channel, 'tok');

        expect(after.calendars).toHaveLength(MAX_CALENDARS_PER_CONNECTION);
        expect(
          after.calendars.every((r) => r.providerCalendarId.startsWith('old')),
        ).toBe(true);
      }));
  });
});
