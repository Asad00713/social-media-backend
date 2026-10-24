import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../testing/rollback-db';
import { PLANNER_PREF_DEFAULTS } from '../lib/planner-prefs';
import { PlannerPreferencesService } from './planner-preferences.service';

const MIGRATION = '0043_planner_preferences.sql';

async function user(client: PoolClient, tag: string) {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`, tag],
  );
  return u.rows[0].id;
}

async function workspace(client: PoolClient, ownerId: string, tag: string) {
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, ownerId],
  );
  return w.rows[0].id;
}

const stored = async (client: PoolClient, userId: string, ws: string) =>
  (
    await client.query<{ prefs: unknown }>(
      `SELECT prefs FROM planner_preferences WHERE user_id = $1 AND workspace_id = $2`,
      [userId, ws],
    )
  ).rows.map((r) => r.prefs);

describeDb('planner_preferences (0043) and PlannerPreferencesService', () => {
  const run = (
    fn: (svc: PlannerPreferencesService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      await fn(new PlannerPreferencesService(db), client);
    });

  it('get returns the defaults without writing a row', () =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      await expect(svc.get(u, ws)).resolves.toEqual(PLANNER_PREF_DEFAULTS);
      expect(await stored(client, u, ws)).toEqual([]);
    }));

  it('the first PUT creates the row, the second merges and keeps untouched keys', () =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      const first = await svc.update(u, ws, {
        colorBy: 'channel',
        show: { notes: false },
      });
      expect(first).toEqual({
        ...PLANNER_PREF_DEFAULTS,
        colorBy: 'channel',
        show: { ...PLANNER_PREF_DEFAULTS.show, notes: false },
      });
      const second = await svc.update(u, ws, {
        weekStartsOn: 1,
        show: { media: false },
      });
      expect(second).toEqual({
        ...PLANNER_PREF_DEFAULTS,
        colorBy: 'channel',
        weekStartsOn: 1,
        show: { ...PLANNER_PREF_DEFAULTS.show, notes: false, media: false },
      });
      expect(await stored(client, u, ws)).toEqual([
        {
          colorBy: 'channel',
          weekStartsOn: 1,
          show: { notes: false, media: false },
        },
      ]);
      await expect(svc.get(u, ws)).resolves.toEqual(second);
    }));

  it('visibleCalendarIds: set, then null removes the stored key', () =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      const id = '55555555-5555-4555-8555-555555555555';
      await expect(
        svc.update(u, ws, { visibleCalendarIds: [id] }),
      ).resolves.toMatchObject({ visibleCalendarIds: [id] });
      await expect(
        svc.update(u, ws, { visibleCalendarIds: null }),
      ).resolves.toMatchObject({ visibleCalendarIds: null });
      expect(await stored(client, u, ws)).toEqual([{}]);
    }));

  it('an empty PUT returns the current prefs and writes nothing', () =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      await expect(svc.update(u, ws, {})).resolves.toEqual(
        PLANNER_PREF_DEFAULTS,
      );
      expect(await stored(client, u, ws)).toEqual([]);
      await svc.update(u, ws, { postSize: 'compact' });
      await expect(svc.update(u, ws, {})).resolves.toMatchObject({
        postSize: 'compact',
      });
    }));

  it.each([
    ['a null-only body', { postSize: null }],
    ['an empty show', { show: {} }],
  ])('%s creates no row', (_label, patch) =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      await expect(
        svc.update(u, ws, patch as unknown as Parameters<typeof svc.update>[2]),
      ).resolves.toEqual(PLANNER_PREF_DEFAULTS);
      expect(await stored(client, u, ws)).toEqual([]);
    }),
  );

  it('two users in one workspace stay independent; so do two workspaces', () =>
    run(async (svc, client) => {
      const a = await user(client, 'a');
      const b = await user(client, 'b');
      const ws1 = await workspace(client, a, 'w1');
      const ws2 = await workspace(client, a, 'w2');
      await svc.update(a, ws1, { colorBy: 'channel' });
      await svc.update(b, ws1, { colorBy: 'campaign' });
      await svc.update(a, ws2, { postSize: 'compact' });
      expect((await svc.get(a, ws1)).colorBy).toBe('channel');
      expect((await svc.get(b, ws1)).colorBy).toBe('campaign');
      expect((await svc.get(a, ws2)).colorBy).toBe('status');
      expect((await svc.get(a, ws2)).postSize).toBe('compact');
      expect((await svc.get(a, ws1)).postSize).toBe('comfortable');
    }));

  it('get resolves a row whose stored JSON is garbage, without throwing', () =>
    run(async (svc, client) => {
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      await client.query(
        `INSERT INTO planner_preferences (user_id, workspace_id, prefs)
         VALUES ($1, $2, $3::jsonb)`,
        [u, ws, JSON.stringify({ postSize: 'huge', colorBy: 'channel', x: 1 })],
      );
      await expect(svc.get(u, ws)).resolves.toEqual({
        ...PLANNER_PREF_DEFAULTS,
        colorBy: 'channel',
      });
      // A write over garbage drops it.
      await svc.update(u, ws, { weekStartsOn: 1 });
      expect(await stored(client, u, ws)).toEqual([
        { colorBy: 'channel', weekStartsOn: 1 },
      ]);
    }));

  describe('cascades', () => {
    it('deleting the user deletes their rows only', () =>
      run(async (svc, client) => {
        const a = await user(client, 'a');
        const b = await user(client, 'b');
        const ws = await workspace(client, b, 'w');
        await svc.update(a, ws, { colorBy: 'channel' });
        await svc.update(b, ws, { colorBy: 'campaign' });
        await client.query(`DELETE FROM users WHERE id = $1`, [a]);
        expect(await stored(client, a, ws)).toEqual([]);
        expect(await stored(client, b, ws)).toHaveLength(1);
      }));

    it('deleting the workspace deletes its rows', () =>
      run(async (svc, client) => {
        const a = await user(client, 'a');
        const ws = await workspace(client, a, 'w');
        await svc.update(a, ws, { colorBy: 'channel' });
        await client.query(`DELETE FROM workspace WHERE id = $1`, [ws]);
        const left = await client.query(
          `SELECT 1 FROM planner_preferences WHERE workspace_id = $1`,
          [ws],
        );
        expect(left.rowCount).toBe(0);
      }));
  });

  it('sequential PUTs over an existing row both succeed and keep both keys', () =>
    run(async (svc, client) => {
      // One connection serialises them, but the ensure-row step must not
      // fail when the row already exists (what the loser of a race sees).
      const u = await user(client, 'a');
      const ws = await workspace(client, u, 'a');
      await client.query(
        `INSERT INTO planner_preferences (user_id, workspace_id) VALUES ($1, $2)`,
        [u, ws],
      );
      await expect(
        svc.update(u, ws, { colorBy: 'channel' }),
      ).resolves.toMatchObject({ colorBy: 'channel' });
      await expect(
        svc.update(u, ws, { postSize: 'compact' }),
      ).resolves.toMatchObject({ colorBy: 'channel', postSize: 'compact' });
    }));
});
