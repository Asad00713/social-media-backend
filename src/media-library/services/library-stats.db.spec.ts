import { sql } from 'drizzle-orm';
import {
  describeLibraryDb,
  withLibraryDb,
  seedWorkspace,
  seedMediaItem,
  seedTemplate,
  seedSnippet,
  seedLink,
  seedCategory,
  seedPost,
  seedUsage,
  seedSubscription,
  seedCampaignSlot,
  seedEvergreenPost,
} from '../testing/library-db';
import {
  itemInReferenceKeysSql,
  itemReferencedSql,
  workspaceReferenceKeysSql,
} from '../lib/usage-sql';
import { StorageQuotaService } from './storage-quota.service';
import { LibraryStatsService } from './library-stats.service';

const ROLL_BACK = new Error('roll back');
const FREE = 524288000;
const PRO = 10737418240;

describeLibraryDb('StorageQuotaService', () => {
  it('sums every item (bin included) and treats null size as 0', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const base = { workspaceId: ws, uploadedById: ownerId };
      await seedMediaItem(client, { ...base, fileSize: 100 });
      await seedMediaItem(client, { ...base, fileSize: 50, isDeleted: true });
      await seedMediaItem(client, { ...base, fileSize: null });
      const other = await seedWorkspace(client);
      await seedMediaItem(client, {
        workspaceId: other.workspaceId,
        uploadedById: other.ownerId,
        fileSize: 999,
      });
      const usage = await new StorageQuotaService(db).getUsage(ws);
      expect(usage.used).toBe(150);
    });
  });

  it('limit is the usage row limit plus extra storage', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      await seedUsage(client, ws, {
        storageBytesLimit: 1000,
        extraStoragePurchased: 200,
      });
      expect((await new StorageQuotaService(db).getUsage(ws)).limit).toBe(1200);
    });
  });

  it('without a usage row the active plan decides; past_due and none fall back to FREE (B7)', async () => {
    await withLibraryDb(async (db, client) => {
      const svc = new StorageQuotaService(db);
      await client.query(
        `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace, members_per_workspace, max_workspaces, storage_bytes_per_workspace)
         VALUES ('PRO', 'Pro', 0, 3, 1, 1, $1)
         ON CONFLICT (code) DO UPDATE SET storage_bytes_per_workspace = $1`,
        [PRO],
      );
      const a = await seedWorkspace(client);
      await seedSubscription(client, a.ownerId, 'PRO', 'active');
      expect((await svc.getUsage(a.workspaceId)).limit).toBe(PRO);

      const b = await seedWorkspace(client);
      await seedSubscription(client, b.ownerId, 'PRO', 'past_due');
      expect((await svc.getUsage(b.workspaceId)).limit).toBe(FREE);

      const c = await seedWorkspace(client);
      expect((await svc.getUsage(c.workspaceId)).limit).toBe(FREE);
    });
  });

  it('a trialing subscription counts as active for the storage limit', async () => {
    await withLibraryDb(async (db, client) => {
      await client.query(
        `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace, members_per_workspace, max_workspaces, storage_bytes_per_workspace)
         VALUES ('PRO', 'Pro', 0, 3, 1, 1, $1)
         ON CONFLICT (code) DO UPDATE SET storage_bytes_per_workspace = $1`,
        [PRO],
      );
      const a = await seedWorkspace(client);
      await seedSubscription(client, a.ownerId, 'PRO', 'trialing');
      expect(
        (await new StorageQuotaService(db).getUsage(a.workspaceId)).limit,
      ).toBe(PRO);
    });
  });

  it('assertCanStore throws StorageFullException past the limit', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      await seedUsage(client, ws, { storageBytesLimit: 100 });
      await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileSize: 90,
      });
      const svc = new StorageQuotaService(db);
      await expect(svc.assertCanStore(ws, 10)).resolves.toEqual({
        used: 90,
        limit: 100,
      });
      await expect(svc.assertCanStore(ws, 11)).rejects.toMatchObject({
        status: 413,
      });
    });
  });

  it('runLocked takes a different lock per workspace and releases it with its transaction', async () => {
    await withLibraryDb(async (db, client) => {
      const wsA = '00000000-0000-0000-0000-00000000000a';
      const wsB = '00000000-0000-0000-0000-00000000000b';
      const svc = new StorageQuotaService(db);
      const held = async () =>
        (
          await client.query<{ k: string }>(
            `SELECT ((classid::bigint << 32) | objid::bigint)::text AS k
               FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
          )
        ).rows.map((r) => r.k);

      // The harness wraps a spec in one outer transaction, so runLocked nests
      // as a savepoint. A lock taken inside a rolled-back savepoint is
      // released with it, which is exactly the transaction scope we assert.
      const keyOf = async (ws: string) => {
        let key = '';
        await svc
          .runLocked(ws, async () => {
            const locks = await held();
            expect(locks).toHaveLength(1);
            key = locks[0];
            throw ROLL_BACK;
          })
          .catch((e: unknown) => {
            if (e !== ROLL_BACK) throw e;
          });
        expect(await held()).toEqual([]);
        return key;
      };
      const a = await keyOf(wsA);
      const b = await keyOf(wsB);
      expect(a).not.toBe('');
      expect(b).not.toBe('');
      expect(a).not.toBe(b);
    });
  });
});

describeLibraryDb('LibraryStatsService.getStats', () => {
  it('aggregates storage, unused, bin and counts in the contract shape', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId: u } = await seedWorkspace(client);
      await seedUsage(client, ws, { storageBytesLimit: 10000 });
      const base = { workspaceId: ws, uploadedById: u };
      await seedMediaItem(client, {
        ...base,
        type: 'image',
        fileSize: 100,
        isStarred: true,
      });
      await seedMediaItem(client, { ...base, type: 'image', fileSize: 200 });
      await seedMediaItem(client, { ...base, type: 'gif', fileSize: 50 });
      const videoUrl = 'https://cdn.example.test/video-used.mp4';
      await seedMediaItem(client, {
        ...base,
        type: 'video',
        fileSize: 1000,
        fileUrl: videoUrl,
      });
      await seedMediaItem(client, { ...base, type: 'document', fileSize: 10 });
      await seedMediaItem(client, {
        ...base,
        type: 'image',
        fileSize: 500,
        isDeleted: true,
      });
      await seedPost(client, {
        workspaceId: ws,
        createdById: u,
        mediaItems: [{ url: videoUrl, type: 'video' }],
      });

      const t = { workspaceId: ws, createdById: u };
      await seedTemplate(client, { ...t, templateType: 'post' });
      await seedTemplate(client, { ...t, templateType: 'post' });
      await seedTemplate(client, { ...t, templateType: 'story' });
      await seedTemplate(client, {
        ...t,
        templateType: 'reel',
        isDeleted: true,
      });
      await seedSnippet(client, { ...t, snippetType: 'caption' });
      await seedSnippet(client, { ...t, snippetType: 'signature' });
      await seedSnippet(client, { ...t, snippetType: 'other' });
      await seedLink(client, t);
      await seedLink(client, { ...t, isDeleted: true });
      await seedCategory(client, ws, 'media');
      await seedCategory(client, ws, 'media');
      await seedCategory(client, ws, 'link');

      const stats = await new LibraryStatsService(
        db,
        new StorageQuotaService(db),
      ).getStats(ws);
      expect(stats).toEqual({
        storage: {
          used: 1860,
          limit: 10000,
          percent: 18.6,
          level: 'ok',
          byType: { images: 350, videos: 1000, docs: 10 },
        },
        unused: { count: 4, bytes: 360 },
        bin: { count: 3, bytes: 500 },
        counts: {
          media: { all: 5, images: 3, videos: 1, docs: 1 },
          templates: { all: 3, post: 2, story: 1, reel: 0, carousel: 0 },
          snippets: { all: 3, caption: 1, hashtags: 0, cta: 0, signature: 1 },
          links: 1,
          folders: { media: 2, template: 0, text_snippet: 0, link: 1 },
        },
      });
    });
  });
});

describeLibraryDb('LibraryStatsService workspace isolation', () => {
  it('counts nothing from another workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const mine = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      await seedMediaItem(client, {
        workspaceId: other.workspaceId,
        uploadedById: other.ownerId,
        fileSize: 777,
      });
      const o = { workspaceId: other.workspaceId, createdById: other.ownerId };
      await seedTemplate(client, o);
      await seedSnippet(client, o);
      await seedLink(client, o);
      await seedCategory(client, other.workspaceId, 'media');
      const stats = await new LibraryStatsService(
        db,
        new StorageQuotaService(db),
      ).getStats(mine.workspaceId);
      expect(stats.storage.used).toBe(0);
      expect(stats.storage.byType).toEqual({ images: 0, videos: 0, docs: 0 });
      expect(stats.unused).toEqual({ count: 0, bytes: 0 });
      expect(stats.bin).toEqual({ count: 0, bytes: 0 });
      expect(stats.counts).toEqual({
        media: { all: 0, images: 0, videos: 0, docs: 0 },
        templates: { all: 0, post: 0, story: 0, reel: 0, carousel: 0 },
        snippets: { all: 0, caption: 0, hashtags: 0, cta: 0, signature: 0 },
        links: 0,
        folders: { media: 0, template: 0, text_snippet: 0, link: 0 },
      });
    });
  });
});

describeLibraryDb('workspaceReferenceKeysSql vs itemReferencedSql', () => {
  // The guard against drift: the set-based form (stats) and the per-item
  // predicate (/usage, purge) must give the same verdict for every item.
  it('agree on every item of a mixed fixture', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId: u } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const base = { workspaceId: ws, uploadedById: u };
      const url = (n: string) => `https://cdn.example.test/${n}.png`;
      const mk = (n: string, extra: Record<string, unknown> = {}) =>
        seedMediaItem(client, { ...base, fileUrl: url(n), ...extra });

      const byId = await mk('by-id');
      await mk('by-url');
      const nested = await mk('nested');
      const slotPending = await mk('slot-pending');
      const slotMaterialised = await mk('slot-materialised');
      const evergreen = await mk('evergreen');
      await mk('evergreen-variation');
      const otherWs = await mk('other-ws');
      const binned = await mk('binned', { isDeleted: true });
      await mk('unused');
      const evergreenRetired = await mk('evergreen-retired');
      const otherSlot = await mk('other-slot');
      const otherEvergreen = await mk('other-evergreen');
      await mk('slot-url');
      const malformedArrayId = await mk('malformed-array-id');
      const malformedNested = await mk('malformed-nested');

      const p = { workspaceId: ws, createdById: u };
      await seedPost(client, { ...p, mediaItems: [{ libraryItemId: byId }] });
      await seedPost(client, { ...p, mediaItems: [{ url: url('by-url') }] });
      await seedPost(client, {
        ...p,
        platformContent: {
          x: { deep: { mediaItems: [{ libraryItemId: nested }] } },
        },
      });
      await seedPost(client, { ...p, mediaItems: [{ libraryItemId: binned }] });
      await seedPost(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        mediaItems: [{ libraryItemId: otherWs, url: url('other-ws') }],
      });
      await seedCampaignSlot(client, { ...p, media: [{ id: slotPending }] });
      const materialisedPost = await seedPost(client, p);
      await seedCampaignSlot(client, {
        ...p,
        media: [{ id: slotMaterialised, url: url('slot-materialised') }],
        postId: materialisedPost,
        slotStatus: 'published',
      });
      await seedEvergreenPost(client, { ...p, media: [{ id: evergreen }] });
      await seedEvergreenPost(client, {
        ...p,
        media: [],
        variationMedia: [
          { id: 'not-an-item', url: url('evergreen-variation') },
        ],
      });

      // A retired entry still counts: neither form looks at its status.
      const retired = await seedEvergreenPost(client, {
        ...p,
        media: [{ id: evergreenRetired }],
      });
      await client.query(
        `UPDATE campaign_evergreen_posts SET status = 'retired' WHERE id = $1`,
        [retired.postId],
      );
      // Another workspace's slot and evergreen entry never reference ours,
      // even by the same id or url.
      const o = { workspaceId: other.workspaceId, createdById: other.ownerId };
      await seedCampaignSlot(client, {
        ...o,
        media: [{ id: otherSlot, url: url('other-slot') }],
      });
      await seedEvergreenPost(client, {
        ...o,
        media: [{ id: otherEvergreen, url: url('other-evergreen') }],
      });
      // A slot holding only a url.
      await seedCampaignSlot(client, {
        ...p,
        media: [{ id: 'not-an-item', url: url('slot-url') }],
      });
      // Malformed evergreen media shapes the lax jsonpath still matches.
      const setEvergreenMedia = async (media: unknown) => {
        const e = await seedEvergreenPost(client, { ...p, media: [] });
        await client.query(
          `UPDATE campaign_evergreen_posts
              SET content = jsonb_set(content, '{media}', $2::jsonb) WHERE id = $1`,
          [e.postId, JSON.stringify(media)],
        );
      };
      await setEvergreenMedia([{ id: [malformedArrayId] }]);
      await setEvergreenMedia([[{ id: malformedNested }]]);

      const res = await db.execute<{
        name: string;
        a: boolean;
        b: boolean;
      }>(sql`
        WITH keys AS MATERIALIZED (${workspaceReferenceKeysSql(ws)})
        SELECT file_url AS name,
               ${itemReferencedSql({
                 id: sql`media_items.id`,
                 fileUrl: sql`media_items.file_url`,
                 workspaceId: sql`media_items.workspace_id`,
               })} AS a,
               ${itemInReferenceKeysSql({ id: sql`media_items.id`, fileUrl: sql`media_items.file_url` })} AS b
          FROM media_items WHERE workspace_id = ${ws}::uuid
      `);
      expect(res.rows).toHaveLength(16);
      for (const r of res.rows) {
        expect({ name: r.name, set: r.b }).toEqual({ name: r.name, set: r.a });
      }
      const referenced = res.rows
        .filter((r) => r.a)
        .map((r) => r.name.split('/').pop())
        .sort();
      expect(referenced).toEqual(
        [
          'binned.png',
          'by-id.png',
          'by-url.png',
          'evergreen-retired.png',
          'evergreen-variation.png',
          'evergreen.png',
          'malformed-array-id.png',
          'malformed-nested.png',
          'nested.png',
          'slot-pending.png',
          'slot-url.png',
        ].sort(),
      );
    });
  });
});
