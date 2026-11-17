import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { LabelsService } from './labels.service';
import { PostLabelsService } from './post-labels.service';

const MIGRATIONS = ['0090_workspace_labels.sql'];

async function seedPost(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  metadata: unknown = { title: 'T', labels: ['Legacy'], campaignId: 'c' },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO posts (id, workspace_id, created_by_id, content, status, metadata)
     VALUES ($1, $2, $3, 'Draft', 'draft', $4::jsonb)`,
    [id, workspaceId, userId, JSON.stringify(metadata)],
  );
  return id;
}

/** The post's labels as (name, colour, deleted) in name order. */
async function labelsOf(client: PoolClient, postId: string) {
  const r = await client.query<{
    id: string;
    name: string;
    color: string;
    deleted: boolean;
  }>(
    `SELECT l.id, l.name, l.color, l.deleted_at IS NOT NULL AS deleted
       FROM post_labels pl JOIN workspace_labels l ON l.id = pl.label_id
      WHERE pl.post_id = $1
      ORDER BY lower(l.name)`,
    [postId],
  );
  return r.rows;
}

async function metadataText(client: PoolClient, postId: string) {
  const r = await client.query<{ m: string }>(
    `SELECT metadata::text AS m FROM posts WHERE id = $1`,
    [postId],
  );
  return r.rows[0].m;
}

describeDb('PostLabelsService (database)', () => {
  it('resolves names case-insensitively, creates the missing ones, replaces the set, and never touches metadata', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const labels = new LabelsService(db);
      const svc = new PostLabelsService(db, labels);
      const promo = await labels.create(ws, ownerId, { name: 'Promo' });
      const post = await seedPost(client, ws, ownerId);
      const before = await metadataText(client, post);

      await svc.setForPost(ws, post, ['Promo', 'promo', ' New   one ']);
      const two = await labelsOf(client, post);
      expect(two.map((l) => l.name)).toEqual(['New one', 'Promo']);
      expect(two.find((l) => l.name === 'Promo')?.id).toBe(promo.id);
      // `Promo` holds blue, so the next palette colour is orange.
      expect(two.find((l) => l.name === 'New one')?.color).toBe('orange');
      const created = await client.query<{ created_by: string | null }>(
        `SELECT created_by FROM workspace_labels WHERE name = 'New one'`,
      );
      expect(created.rows).toEqual([{ created_by: null }]);

      await svc.setForPost(ws, post, ['new one']);
      expect((await labelsOf(client, post)).map((l) => l.name)).toEqual([
        'New one',
      ]);

      await svc.setForPost(ws, post, []);
      expect(await labelsOf(client, post)).toEqual([]);

      // Nothing new in the catalogue from the repeat saves.
      expect(await labels.catalogueNames(ws)).toEqual(['New one', 'Promo']);
      expect(await metadataText(client, post)).toBe(before);
    });
  });

  it('a name matching a soft-deleted label creates a fresh live label; the deleted one stays deleted', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const labels = new LabelsService(db);
      const svc = new PostLabelsService(db, labels);
      const old = await labels.create(ws, ownerId, { name: 'Promo' });
      await labels.remove(ws, old.id);
      const post = await seedPost(client, ws, ownerId);
      const before = await metadataText(client, post);

      await svc.setForPost(ws, post, ['PROMO']);
      const rows = await labelsOf(client, post);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'PROMO', deleted: false });
      expect(rows[0].id).not.toBe(old.id);
      const oldRow = await client.query<{ deleted: boolean }>(
        `SELECT deleted_at IS NOT NULL AS deleted FROM workspace_labels WHERE id = $1`,
        [old.id],
      );
      expect(oldRow.rows).toEqual([{ deleted: true }]);
      expect(await metadataText(client, post)).toBe(before);
    });
  });

  it("keeps a soft-deleted label's row on the post so its Undo still restores it", async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const labels = new LabelsService(db);
      const svc = new PostLabelsService(db, labels);
      const post = await seedPost(client, ws, ownerId);
      await svc.setForPost(ws, post, ['Promo', 'BTS']);
      const promo = (await labelsOf(client, post)).find(
        (l) => l.name === 'Promo',
      )!;
      await labels.remove(ws, promo.id);

      // The composer no longer shows Promo, so the next save omits it.
      await svc.setForPost(ws, post, ['BTS']);
      await labels.restore(ws, promo.id);
      expect((await labelsOf(client, post)).map((l) => l.name)).toEqual([
        'BTS',
        'Promo',
      ]);
    });
  });

  it('retries once when the resolved label vanishes before the insert (a merge committing mid-save)', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const labels = new LabelsService(db);
      const svc = new PostLabelsService(db, labels);
      const source = await labels.create(ws, ownerId, { name: 'Promo' });
      const post = await seedPost(client, ws, ownerId);

      // After the first resolve, delete the resolved label the way a merge
      // does, so the post_labels insert hits its foreign key (23503).
      type Resolve = (...a: unknown[]) => Promise<string[]>;
      const seam = svc as unknown as { resolveIds: Resolve };
      const original: Resolve = seam.resolveIds;
      const resolve: Resolve = (...a) => Reflect.apply(original, svc, a);
      const spy = jest
        .spyOn(seam, 'resolveIds')
        .mockImplementationOnce(async (...args: unknown[]) => {
          const ids = await resolve(...args);
          await client.query(`DELETE FROM workspace_labels WHERE id = $1`, [
            source.id,
          ]);
          return ids;
        });

      await expect(
        svc.setForPost(ws, post, ['promo']),
      ).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(2);
      // The single-connection harness rolls the failed attempt back with its
      // savepoint, so the retry resolves the name to the live label again.
      expect((await labelsOf(client, post)).map((l) => l.name)).toEqual([
        'Promo',
      ]);
    });
  });

  it('namesForPosts and idsForPosts batch live labels per post, in name order', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const labels = new LabelsService(db);
      const svc = new PostLabelsService(db, labels);
      const a = await seedPost(client, ws, ownerId);
      const b = await seedPost(client, ws, ownerId);
      const none = await seedPost(client, ws, ownerId);
      await svc.setForPost(ws, a, ['zeta', 'Alpha', 'mid']);
      await svc.setForPost(ws, b, ['Mid']);
      const mid = (await labelsOf(client, b))[0];
      const zeta = (await labelsOf(client, a)).find((l) => l.name === 'zeta')!;
      await labels.remove(ws, zeta.id);

      const names = await svc.namesForPosts([a, b, none]);
      expect(names.get(a)).toEqual(['Alpha', 'mid']);
      expect(names.get(b)).toEqual(['mid']);
      expect(names.get(none)).toBeUndefined();

      const ids = await svc.idsForPosts([a, b, none]);
      expect(ids.get(b)).toEqual([mid.id]);
      expect(ids.get(a)).toHaveLength(2);
      expect(ids.get(a)).not.toContain(zeta.id);

      expect(await svc.namesForPosts([])).toEqual(new Map());
    });
  });

  it('refuses a post from another workspace and leaves it alone', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const mine = await seedWorkspace(client);
      const theirs = await seedWorkspace(client);
      const svc = new PostLabelsService(db, new LabelsService(db));
      const post = await seedPost(client, theirs.workspaceId, theirs.ownerId);
      await expect(
        svc.setForPost(mine.workspaceId, post, ['X']),
      ).rejects.toThrow('Post not found');
      expect(await labelsOf(client, post)).toEqual([]);
    });
  });
});
