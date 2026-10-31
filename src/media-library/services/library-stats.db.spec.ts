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
} from '../testing/library-db';
import { StorageQuotaService } from './storage-quota.service';
import { LibraryStatsService } from './library-stats.service';

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

  it('runLocked holds a transaction advisory lock inside fn', async () => {
    await withLibraryDb(async (db) => {
      const n = await new StorageQuotaService(db).runLocked(
        '00000000-0000-0000-0000-000000000001',
        async (tx) => {
          const r = await tx.execute<{ n: string }>(
            sql`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
          );
          return Number(r.rows[0].n);
        },
      );
      expect(n).toBeGreaterThanOrEqual(1);
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
