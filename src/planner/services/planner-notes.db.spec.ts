import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../testing/rollback-db';
import { PlannerNotesService } from './planner-notes.service';

const MIGRATION = '0042_calendar_notes.sql';

async function workspace(client: PoolClient, tag: string) {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`, tag],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, u.rows[0].id],
  );
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

const insert = (
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  date: string,
  body = 'Sale',
  color = 'amber',
) =>
  client.query(
    `INSERT INTO calendar_notes (workspace_id, date, body, color, created_by_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [w.workspaceId, date, body, color, w.userId],
  );

/** A failing statement aborts the transaction: use a savepoint around it. */
async function violates(client: PoolClient, fn: () => Promise<unknown>) {
  await client.query('SAVEPOINT s');
  try {
    await fn();
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return e as { code?: string; constraint?: string };
  }
  await client.query('RELEASE SAVEPOINT s');
  return null;
}

describeDb('calendar_notes (0042) and PlannerNotesService', () => {
  const run = (
    fn: (svc: PlannerNotesService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      await fn(new PlannerNotesService(db), client);
    });

  describe('table constraints', () => {
    it('allows one note per (workspace, date), and the same date elsewhere', () =>
      run(async (_svc, client) => {
        const a = await workspace(client, 'a');
        const b = await workspace(client, 'b');
        await insert(client, a, '2026-03-05');
        const err = await violates(client, () =>
          insert(client, a, '2026-03-05', 'Other'),
        );
        expect(err?.code).toBe('23505');
        expect(err?.constraint).toBe('calendar_notes_workspace_date_uq');
        await insert(client, b, '2026-03-05');
        await insert(client, a, '2026-03-06');
      }));

    it.each([
      ['empty body', '', 'amber'],
      ['501-character body', 'x'.repeat(501), 'amber'],
      ['colour pink', 'ok', 'pink'],
    ])('rejects %s with a CHECK violation', (_n, body, color) =>
      run(async (_svc, client) => {
        const a = await workspace(client, 'a');
        const err = await violates(client, () =>
          insert(client, a, '2026-03-05', body, color),
        );
        expect(err?.code).toBe('23514');
      }),
    );

    it('accepts a 1-character and a 500-character body', () =>
      run(async (_svc, client) => {
        const a = await workspace(client, 'a');
        await insert(client, a, '2026-03-05', 'x');
        await insert(client, a, '2026-03-06', 'x'.repeat(500));
      }));

    it('sets created_by_id to NULL when the creator is deleted', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'a');
        const other = await client.query<{ id: string }>(
          `INSERT INTO users (email) VALUES ($1) RETURNING id`,
          [`o-${Math.random().toString(36).slice(2, 8)}@example.test`],
        );
        const created = await svc.create(
          a.workspaceId,
          other.rows[0].id,
          'MEMBER',
          { date: '2026-03-05', body: 'x', color: 'blue' },
        );
        await client.query(`DELETE FROM users WHERE id = $1`, [
          other.rows[0].id,
        ]);
        const row = await client.query<{ created_by_id: string | null }>(
          `SELECT created_by_id FROM calendar_notes WHERE id = $1`,
          [created.id],
        );
        expect(row.rows[0].created_by_id).toBeNull();
        const [n] = await svc.list(a.workspaceId, '2026-03-05', '2026-03-05');
        expect(n.author).toBeNull();
      }));
  });

  describe('service', () => {
    it('creates, lists with author, and keeps the plain date', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'ann');
        const note = await svc.create(a.workspaceId, a.userId, 'MEMBER', {
          date: '2026-03-05',
          body: 'Launch',
          color: 'green',
        });
        expect(note).toMatchObject({
          date: '2026-03-05',
          body: 'Launch',
          color: 'green',
          author: { id: a.userId, name: 'ann' },
        });
        await svc.create(a.workspaceId, a.userId, 'MEMBER', {
          date: '2026-03-01',
          body: 'Early',
          color: 'red',
        });
        await svc.create(a.workspaceId, a.userId, 'MEMBER', {
          date: '2026-04-20',
          body: 'Outside',
          color: 'red',
        });
        const list = await svc.list(a.workspaceId, '2026-03-01', '2026-03-31');
        expect(list.map((n) => n.date)).toEqual(['2026-03-01', '2026-03-05']);
      }));

    it('answers a second note on the same day with 409, not another workspace', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'a');
        const b = await workspace(client, 'b');
        const dto = { date: '2026-03-05', body: 'x', color: 'blue' as const };
        await svc.create(a.workspaceId, a.userId, 'MEMBER', dto);
        // The failed INSERT aborts the transaction: isolate it.
        await client.query('SAVEPOINT dup');
        await expect(
          svc.create(a.workspaceId, a.userId, 'MEMBER', dto),
        ).rejects.toBeInstanceOf(ConflictException);
        await client.query('ROLLBACK TO SAVEPOINT dup');
        await expect(
          svc.create(b.workspaceId, b.userId, 'MEMBER', dto),
        ).resolves.toMatchObject({ date: '2026-03-05' });
      }));

    it('update sets updated_by_id and moves updated_at; creator stays the author', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'a');
        const editor = await client.query<{ id: string }>(
          `INSERT INTO users (email, name) VALUES ($1, 'Eddie') RETURNING id`,
          [`e-${Math.random().toString(36).slice(2, 8)}@example.test`],
        );
        const note = await svc.create(a.workspaceId, a.userId, 'MEMBER', {
          date: '2026-03-05',
          body: 'v1',
          color: 'blue',
        });
        await client.query(
          `UPDATE calendar_notes SET updated_at = now() - interval '1 day' WHERE id = $1`,
          [note.id],
        );
        const updated = await svc.update(
          a.workspaceId,
          note.id,
          editor.rows[0].id,
          'MEMBER',
          { body: 'v2' },
        );
        expect(updated).toMatchObject({
          body: 'v2',
          color: 'blue',
          author: { id: a.userId },
        });
        const row = await client.query<{
          updated_by_id: string;
          fresh: boolean;
        }>(
          `SELECT updated_by_id, updated_at > now() - interval '1 hour' AS fresh
           FROM calendar_notes WHERE id = $1`,
          [note.id],
        );
        expect(row.rows[0].updated_by_id).toBe(editor.rows[0].id);
        expect(row.rows[0].fresh).toBe(true);
      }));

    it('a note id from another workspace is a 404 for update and remove, and is left intact', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'a');
        const b = await workspace(client, 'b');
        const note = await svc.create(a.workspaceId, a.userId, 'MEMBER', {
          date: '2026-03-05',
          body: 'mine',
          color: 'blue',
        });
        await expect(
          svc.update(b.workspaceId, note.id, b.userId, 'MEMBER', {
            body: 'hijack',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.remove(b.workspaceId, note.id, b.userId, 'MEMBER'),
        ).rejects.toBeInstanceOf(NotFoundException);
        const [still] = await svc.list(
          a.workspaceId,
          '2026-03-05',
          '2026-03-05',
        );
        expect(still).toMatchObject({ id: note.id, body: 'mine' });
        await expect(
          svc.list(b.workspaceId, '2026-03-05', '2026-03-05'),
        ).resolves.toEqual([]);
      }));

    it('remove deletes the note and lets the day be reused', () =>
      run(async (svc, client) => {
        const a = await workspace(client, 'a');
        const dto = { date: '2026-03-05', body: 'x', color: 'red' as const };
        const note = await svc.create(a.workspaceId, a.userId, 'MEMBER', dto);
        await svc.remove(a.workspaceId, note.id, a.userId, 'MEMBER');
        await expect(
          svc.create(a.workspaceId, a.userId, 'MEMBER', dto),
        ).resolves.toMatchObject({ date: '2026-03-05' });
      }));
  });
});
