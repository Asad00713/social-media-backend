import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { LabelsService } from './labels.service';

const MIGRATIONS = ['0090_workspace_labels.sql'];

async function seedPost(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO posts (id, workspace_id, created_by_id, content, status)
     VALUES ($1, $2, $3, 'Draft', 'draft')`,
    [id, workspaceId, userId],
  );
  return id;
}

async function tag(
  client: PoolClient,
  postId: string,
  labelId: string,
  createdAt?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO post_labels (post_id, label_id, created_at)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
    [postId, labelId, createdAt ?? null],
  );
}

async function postIdsOf(client: PoolClient, labelId: string) {
  const r = await client.query<{ post_id: string }>(
    `SELECT post_id FROM post_labels WHERE label_id = $1 ORDER BY post_id`,
    [labelId],
  );
  return r.rows.map((x) => x.post_id);
}

async function setDeletedAgo(
  client: PoolClient,
  labelId: string,
  seconds: number,
): Promise<void> {
  await client.query(
    `UPDATE workspace_labels
        SET deleted_at = clock_timestamp() - make_interval(secs => $2)
      WHERE id = $1`,
    [labelId, seconds],
  );
}

/** Resolves to the HTTP status and machine code the promise rejected with. */
async function failure(
  p: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const body = err.getResponse() as { code?: string };
    return { status: err.getStatus(), code: body.code };
  }
  throw new Error('expected the call to fail');
}

describeDb('LabelsService (database)', () => {
  it('rejects a name taken case-insensitively on create and rename; a case-only rename of itself succeeds', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);

      const promo = await svc.create(ws, ownerId, { name: 'Promo' });
      expect(promo).toMatchObject({
        name: 'Promo',
        color: 'blue',
        description: null,
        postCount: 0,
        lastUsedAt: null,
      });
      expect(await failure(svc.create(ws, ownerId, { name: 'promo' }))).toEqual(
        { status: 409, code: 'LABEL_NAME_TAKEN' },
      );

      const bts = await svc.create(ws, ownerId, { name: 'BTS' });
      expect(await failure(svc.update(ws, bts.id, { name: 'PROMO' }))).toEqual({
        status: 409,
        code: 'LABEL_NAME_TAKEN',
      });

      const lower = await svc.update(ws, promo.id, { name: 'promo' });
      expect(lower.name).toBe('promo');
      const back = await svc.update(ws, lower.id, { name: 'Promo' });
      expect(back.name).toBe('Promo');

      // The same name in another workspace is fine.
      const other = await seedWorkspace(client);
      await expect(
        svc.create(other.workspaceId, other.ownerId, { name: 'Promo' }),
      ).resolves.toMatchObject({ name: 'Promo' });
    });
  });

  it('edits colour and description; description null clears it', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const l = await svc.create(ws, ownerId, {
        name: 'Promo',
        color: 'pink',
        description: 'Offers',
      });
      expect(l).toMatchObject({ color: 'pink', description: 'Offers' });

      const edited = await svc.update(ws, l.id, { color: 'teal' });
      expect(edited).toMatchObject({ color: 'teal', description: 'Offers' });
      const cleared = await svc.update(ws, l.id, { description: null });
      expect(cleared).toMatchObject({ color: 'teal', description: null });
    });
  });

  it('picks the first least-used palette colour when none is given (blue, blue, orange -> green)', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);
      await svc.create(ws, ownerId, { name: 'A', color: 'blue' });
      await svc.create(ws, ownerId, { name: 'B', color: 'blue' });
      await svc.create(ws, ownerId, { name: 'C', color: 'orange' });
      // A deleted label does not hold its colour.
      const gone = await svc.create(ws, ownerId, { name: 'D', color: 'green' });
      await svc.remove(ws, gone.id);

      expect(await svc.nextColor(ws)).toBe('green');
      const made = await svc.create(ws, ownerId, { name: 'E' });
      expect(made.color).toBe('green');
    });
  });

  it('merges source into target in one go: moved counts only new rows, source is hard-deleted', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const a = await svc.create(ws, ownerId, { name: 'A' });
      const b = await svc.create(ws, ownerId, { name: 'B' });
      const [p1, p2, p3] = [
        await seedPost(client, ws, ownerId),
        await seedPost(client, ws, ownerId),
        await seedPost(client, ws, ownerId),
      ];
      await tag(client, p1, a.id);
      await tag(client, p2, a.id);
      await tag(client, p2, b.id);
      await tag(client, p3, b.id);

      const res = await svc.merge(ws, a.id, b.id);
      expect(res.moved).toBe(1);
      expect(res.target).toMatchObject({ id: b.id, name: 'B', postCount: 3 });
      expect(await postIdsOf(client, b.id)).toEqual([p1, p2, p3].sort());

      const left = await client.query(
        `SELECT 1 FROM workspace_labels WHERE id = $1`,
        [a.id],
      );
      expect(left.rowCount).toBe(0);
      expect(await postIdsOf(client, a.id)).toEqual([]);
    });
  });

  it('refuses a merge into itself (400), into another workspace (404) or into a deleted label (404), changing nothing', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const a = await svc.create(ws, ownerId, { name: 'A' });
      const dead = await svc.create(ws, ownerId, { name: 'Dead' });
      await svc.remove(ws, dead.id);
      const foreign = await svc.create(other.workspaceId, other.ownerId, {
        name: 'B',
      });
      const p1 = await seedPost(client, ws, ownerId);
      await tag(client, p1, a.id);

      expect(await failure(svc.merge(ws, a.id, a.id))).toEqual({
        status: 400,
        code: 'MERGE_SAME_LABEL',
      });
      expect((await failure(svc.merge(ws, a.id, foreign.id))).status).toBe(404);
      expect((await failure(svc.merge(ws, a.id, dead.id))).status).toBe(404);
      expect(await postIdsOf(client, a.id)).toEqual([p1]);
      expect(await postIdsOf(client, foreign.id)).toEqual([]);
    });
  });

  it('soft-deletes with a 10 s undo; restore brings the label back with its posts', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const l = await svc.create(ws, ownerId, { name: 'Promo' });
      const p1 = await seedPost(client, ws, ownerId);
      const p2 = await seedPost(client, ws, ownerId);
      await tag(client, p1, l.id);
      await tag(client, p2, l.id);

      const before = Date.now();
      const { undoUntil } = await svc.remove(ws, l.id);
      const until = new Date(undoUntil).getTime();
      expect(until).toBeGreaterThanOrEqual(before + 10_000 - 2_000);
      expect(until).toBeLessThanOrEqual(Date.now() + 10_000 + 2_000);

      const listed = await svc.list(ws);
      expect(listed).toEqual({ labels: [], total: 0 });
      expect(await svc.catalogueNames(ws)).toEqual([]);
      expect(await postIdsOf(client, l.id)).toEqual([p1, p2].sort());

      // Deleting it again is a 404: it is no longer live.
      expect((await failure(svc.remove(ws, l.id))).status).toBe(404);

      const restored = await svc.restore(ws, l.id);
      expect(restored).toMatchObject({ id: l.id, name: 'Promo', postCount: 2 });
      expect((await svc.list(ws)).total).toBe(1);
    });
  });

  it('refuses a restore once the name was reused (409) or after 60 s (410)', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);

      const reused = await svc.create(ws, ownerId, { name: 'Promo' });
      await svc.remove(ws, reused.id);
      await svc.create(ws, ownerId, { name: 'PROMO' });
      expect(await failure(svc.restore(ws, reused.id))).toEqual({
        status: 409,
        code: 'LABEL_NAME_TAKEN',
      });

      const late = await svc.create(ws, ownerId, { name: 'Late' });
      await svc.remove(ws, late.id);
      await setDeletedAgo(client, late.id, 61);
      expect(await failure(svc.restore(ws, late.id))).toEqual({
        status: 410,
        code: 'UNDO_EXPIRED',
      });
      const row = await client.query<{ deleted: boolean }>(
        `SELECT deleted_at IS NOT NULL AS deleted FROM workspace_labels WHERE id = $1`,
        [late.id],
      );
      expect(row.rows[0].deleted).toBe(true);
    });
  });

  it('purgeExpired hard-deletes labels deleted over 10 min ago (cascading post_labels) and keeps younger ones', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const old = await svc.create(ws, ownerId, { name: 'Old' });
      const young = await svc.create(ws, ownerId, { name: 'Young' });
      const foreignOld = await svc.create(other.workspaceId, other.ownerId, {
        name: 'Old',
      });
      const p1 = await seedPost(client, ws, ownerId);
      await tag(client, p1, old.id);
      await tag(client, p1, young.id);
      await setDeletedAgo(client, old.id, 11 * 60);
      await setDeletedAgo(client, young.id, 9 * 60);
      await setDeletedAgo(client, foreignOld.id, 11 * 60);

      await svc.purgeExpired(ws);

      const ids = await client.query<{ id: string }>(
        `SELECT id FROM workspace_labels WHERE id = ANY($1::uuid[])`,
        [[old.id, young.id, foreignOld.id]],
      );
      expect(ids.rows.map((r) => r.id).sort()).toEqual(
        [young.id, foreignOld.id].sort(),
      );
      expect(await postIdsOf(client, old.id)).toEqual([]);
      expect(await postIdsOf(client, young.id)).toEqual([p1]);
    });
  });

  it('runs the purge first on every label write', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const old = await svc.create(ws, ownerId, { name: 'Old' });
      await setDeletedAgo(client, old.id, 11 * 60);

      await svc.create(ws, ownerId, { name: 'Fresh' });

      const left = await client.query(
        `SELECT 1 FROM workspace_labels WHERE id = $1`,
        [old.id],
      );
      expect(left.rowCount).toBe(0);
    });
  });

  it('lists live labels in name order with per-label counts and last use', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const zeta = await svc.create(ws, ownerId, { name: 'zeta' });
      const alpha = await svc.create(ws, ownerId, {
        name: 'Alpha',
        description: 'First',
      });
      const never = await svc.create(ws, ownerId, { name: 'Beta' });
      await svc.create(other.workspaceId, other.ownerId, { name: 'Elsewhere' });
      const [p1, p2] = [
        await seedPost(client, ws, ownerId),
        await seedPost(client, ws, ownerId),
      ];
      await tag(client, p1, alpha.id, '2026-11-01T10:00:00Z');
      await tag(client, p2, alpha.id, '2026-11-03T10:00:00Z');
      await tag(client, p1, zeta.id, '2026-11-02T10:00:00Z');

      const { labels, total } = await svc.list(ws);
      expect(total).toBe(3);
      expect(labels.map((l) => l.name)).toEqual(['Alpha', 'Beta', 'zeta']);
      expect(labels[0]).toEqual({
        id: alpha.id,
        name: 'Alpha',
        color: alpha.color,
        description: 'First',
        postCount: 2,
        lastUsedAt: '2026-11-03T10:00:00.000Z',
      });
      expect(labels[1]).toMatchObject({
        id: never.id,
        postCount: 0,
        lastUsedAt: null,
      });
      expect(labels[2]).toMatchObject({
        id: zeta.id,
        postCount: 1,
        lastUsedAt: '2026-11-02T10:00:00.000Z',
      });
      expect(await svc.catalogueNames(ws)).toEqual(['Alpha', 'Beta', 'zeta']);
    });
  });

  it('answers 404 on every mutation for a label of another workspace, and changes nothing', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const x = await seedWorkspace(client);
      const y = await seedWorkspace(client);
      const svc = new LabelsService(db);
      const inX = await svc.create(x.workspaceId, x.ownerId, { name: 'X' });
      const inY = await svc.create(y.workspaceId, y.ownerId, { name: 'Y' });
      const ws = y.workspaceId;

      expect(
        (await failure(svc.update(ws, inX.id, { name: 'Z' }))).status,
      ).toBe(404);
      expect((await failure(svc.merge(ws, inX.id, inY.id))).status).toBe(404);
      expect((await failure(svc.remove(ws, inX.id))).status).toBe(404);
      expect((await failure(svc.restore(ws, inX.id))).status).toBe(404);
      // A deleted label of X cannot be restored from Y either.
      await svc.remove(x.workspaceId, inX.id);
      expect((await failure(svc.restore(ws, inX.id))).status).toBe(404);
      expect((await failure(svc.update(ws, randomUUID(), {}))).status).toBe(
        404,
      );

      const row = await client.query<{ name: string }>(
        `SELECT name FROM workspace_labels WHERE id = $1`,
        [inX.id],
      );
      expect(row.rows[0].name).toBe('X');
    });
  });
});
