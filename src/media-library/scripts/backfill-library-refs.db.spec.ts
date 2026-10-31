import type { Client, PoolClient } from 'pg';
import {
  describeLibraryDb,
  seedMediaItem,
  seedPost,
  seedWorkspace,
  withLibraryDb,
} from '../testing/library-db';
import { runBackfillLibraryRefs } from './backfill-library-refs';

const LOCAL_URL = 'postgres://user:pw@localhost:5432/test';

/** Hands the rollback harness connection to the script; `end` must not close it. */
function harnessConnect(client: PoolClient) {
  const wrapped = {
    query: (text: string, params?: unknown[]) => client.query(text, params),
    end: () => Promise.resolve(),
  } as unknown as Client;
  return () => Promise.resolve(wrapped);
}

describe('runBackfillLibraryRefs target guard', () => {
  it('refuses a .railway.internal host without the production flag, before connecting', async () => {
    const connect = jest.fn();
    await expect(
      runBackfillLibraryRefs({
        databaseUrl: 'postgres://u:p@db.railway.internal:5432/railway',
        confirmedProduction: false,
        connect,
      }),
    ).rejects.toThrow(/--i-know-this-is-production/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a public non-local host without the flag', async () => {
    const connect = jest.fn();
    await expect(
      runBackfillLibraryRefs({
        databaseUrl: 'postgres://u:p@prod.example.com:5432/db',
        confirmedProduction: false,
        connect,
      }),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

describeLibraryDb('runBackfillLibraryRefs', () => {
  it('stamps libraryItemId on matching entries and leaves everything else alone', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(
        (n) => `https://cdn.example.test/${n}-${crypto.randomUUID()}.png`,
      );
      const base = { workspaceId, uploadedById: ownerId };
      const itemA = await seedMediaItem(client, { ...base, fileUrl: a });
      const itemC = await seedMediaItem(client, {
        ...base,
        fileUrl: c,
        isDeleted: true,
        deletedAt: new Date(),
      });
      const dOld = await seedMediaItem(client, {
        ...base,
        fileUrl: d,
        createdAt: new Date('2020-01-01T00:00:00Z'),
      });
      const dNew = await seedMediaItem(client, {
        ...base,
        fileUrl: d,
        createdAt: new Date('2021-01-01T00:00:00Z'),
      });
      const keptId = crypto.randomUUID();

      const postId = await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        mediaItems: [
          { url: a, type: 'image' },
          { url: b, type: 'image', libraryItemId: keptId },
          { url: b, type: 'image' },
          { url: c, type: 'image' },
          { url: d, type: 'image' },
        ],
      });
      // Make updated_at distinguishable from "now" so a touch would show.
      await client.query(
        `UPDATE posts SET updated_at = '2020-06-01T00:00:00Z' WHERE id = $1`,
        [postId],
      );

      const res = await runBackfillLibraryRefs({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        connect: harnessConnect(client),
      });

      const row = await client.query<{
        media_items: Array<{ url: string; libraryItemId?: string }>;
        updated_at: Date;
      }>(`SELECT media_items, updated_at FROM posts WHERE id = $1`, [postId]);
      const entries = row.rows[0].media_items;
      expect(entries.map((e) => e.libraryItemId)).toEqual([
        itemA,
        keptId,
        undefined,
        itemC,
        dOld,
      ]);
      expect(entries.map((e) => e.url)).toEqual([a, b, b, c, d]);
      expect(row.rows[0].updated_at.toISOString()).toBe(
        '2020-06-01T00:00:00.000Z',
      );
      expect(res.postsUpdated).toBe(1);

      // The 0055 trigger recounted usage for the items that are now referenced.
      const usage = async (id: string) =>
        (
          await client.query<{ usage_count: number }>(
            `SELECT usage_count FROM media_items WHERE id = $1`,
            [id],
          )
        ).rows[0].usage_count;
      expect(await usage(itemA)).toBe(1);
      expect(await usage(dOld)).toBe(1);
      // Usage is counted per URL, so the younger twin shares the count.
      expect(await usage(dNew)).toBe(1);
    });
  });

  it('is idempotent: a second run updates nothing', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const url = `https://cdn.example.test/${crypto.randomUUID()}.png`;
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        fileUrl: url,
      });
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        mediaItems: [{ url, type: 'image' }],
      });
      const opts = {
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        connect: harnessConnect(client),
      };
      expect((await runBackfillLibraryRefs(opts)).postsUpdated).toBe(1);
      expect((await runBackfillLibraryRefs(opts)).postsUpdated).toBe(0);
    });
  });

  it('only matches items of the same workspace and skips non-array media_items', async () => {
    await withLibraryDb(async (_db, client) => {
      const one = await seedWorkspace(client);
      const two = await seedWorkspace(client);
      const url = `https://cdn.example.test/${crypto.randomUUID()}.png`;
      await seedMediaItem(client, {
        workspaceId: two.workspaceId,
        uploadedById: two.ownerId,
        fileUrl: url,
      });
      const foreign = await seedPost(client, {
        workspaceId: one.workspaceId,
        createdById: one.ownerId,
        mediaItems: [{ url, type: 'image' }],
      });
      const nulled = await seedPost(client, {
        workspaceId: one.workspaceId,
        createdById: one.ownerId,
      });
      await client.query(`UPDATE posts SET media_items = NULL WHERE id = $1`, [
        nulled,
      ]);

      const res = await runBackfillLibraryRefs({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        batchSize: 1,
        connect: harnessConnect(client),
      });

      expect(res.postsUpdated).toBe(0);
      const r = await client.query<{ media_items: unknown }>(
        `SELECT media_items FROM posts WHERE id = $1`,
        [foreign],
      );
      expect(r.rows[0].media_items).toEqual([{ url, type: 'image' }]);
    });
  });
});
