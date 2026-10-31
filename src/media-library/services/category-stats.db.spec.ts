import type { PoolClient } from 'pg';
import {
  describeLibraryDb,
  withLibraryDb,
  seedWorkspace,
  seedCategory,
  seedMediaItem,
  seedTemplate,
  seedLink,
  seedSnippet,
} from '../testing/library-db';
import { CategoryService } from './category.service';

const BASE = Date.UTC(2026, 0, 1);
const at = (minute: number) => new Date(BASE + minute * 60 * 1000);

async function setCreatedAt(
  client: PoolClient,
  table: 'media_templates' | 'saved_links',
  id: string,
  createdAt: Date,
): Promise<void> {
  await client.query(`UPDATE ${table} SET created_at = $2 WHERE id = $1`, [
    id,
    createdAt,
  ]);
}

describeLibraryDb('CategoryService.findAll stats and search', () => {
  it('counts live media, sums their bytes and takes the 4 newest covers', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const folder = await seedCategory(client, workspaceId, 'media', 'Launch');
      const base = { workspaceId, uploadedById: ownerId, categoryId: folder };
      await seedMediaItem(client, {
        ...base,
        type: 'image',
        fileUrl: 'https://cdn.test/1.png',
        fileSize: 100,
        createdAt: at(1),
      });
      await seedMediaItem(client, {
        ...base,
        type: 'video',
        fileUrl: 'https://cdn.test/2.mp4',
        thumbnailUrl: 'https://cdn.test/2-thumb.jpg',
        fileSize: 200,
        createdAt: at(2),
      });
      // A video without a thumbnail has no cover.
      await seedMediaItem(client, {
        ...base,
        type: 'video',
        fileUrl: 'https://cdn.test/3.mp4',
        fileSize: 300,
        createdAt: at(3),
      });
      await seedMediaItem(client, {
        ...base,
        type: 'gif',
        fileUrl: 'https://cdn.test/4.gif',
        fileSize: 400,
        createdAt: at(4),
      });
      await seedMediaItem(client, {
        ...base,
        type: 'image',
        fileUrl: 'https://cdn.test/5.png',
        fileSize: 500,
        createdAt: at(5),
      });
      // The newest row is in the bin: neither counted nor a cover.
      await seedMediaItem(client, {
        ...base,
        type: 'image',
        fileUrl: 'https://cdn.test/6.png',
        fileSize: 600,
        isDeleted: true,
        deletedAt: at(7),
        createdAt: at(6),
      });
      // Another folder's item stays out.
      const other = await seedCategory(client, workspaceId, 'media', 'Other');
      await seedMediaItem(client, {
        ...base,
        categoryId: other,
        fileUrl: 'https://cdn.test/other.png',
        fileSize: 9999,
        createdAt: at(9),
      });

      const rows = await new CategoryService(db).findAll(workspaceId, {
        withStats: true,
      });
      const launch = rows.find((r) => r.id === folder);
      expect(launch?.stats).toEqual({
        itemCount: 5,
        bytes: 1500,
        covers: [
          'https://cdn.test/5.png',
          'https://cdn.test/4.gif',
          'https://cdn.test/2-thumb.jpg',
          'https://cdn.test/1.png',
        ],
      });
    });
  });

  it('caps covers at four and gives an empty folder zero stats', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const full = await seedCategory(client, workspaceId, 'media', 'Full');
      const empty = await seedCategory(client, workspaceId, 'media', 'Empty');
      for (let n = 1; n <= 6; n++) {
        await seedMediaItem(client, {
          workspaceId,
          uploadedById: ownerId,
          categoryId: full,
          fileUrl: `https://cdn.test/f${n}.png`,
          createdAt: at(n),
        });
      }
      const rows = await new CategoryService(db).findAll(workspaceId, {
        withStats: true,
      });
      expect(rows.find((r) => r.id === full)?.stats).toEqual({
        itemCount: 6,
        bytes: 0,
        covers: [6, 5, 4, 3].map((n) => `https://cdn.test/f${n}.png`),
      });
      expect(rows.find((r) => r.id === empty)?.stats).toEqual({
        itemCount: 0,
        bytes: 0,
        covers: [],
      });
    });
  });

  it('takes template covers from thumbnails, link covers from previews, and gives snippets none', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const tpl = await seedCategory(client, workspaceId, 'template', 'Tpl');
      const lnk = await seedCategory(client, workspaceId, 'link', 'Lnk');
      const snp = await seedCategory(
        client,
        workspaceId,
        'text_snippet',
        'Snp',
      );
      const t = { workspaceId, createdById: ownerId };

      const t1 = await seedTemplate(client, {
        ...t,
        categoryId: tpl,
        thumbnailUrl: 'https://cdn.test/t1.jpg',
      });
      const t2 = await seedTemplate(client, { ...t, categoryId: tpl });
      const t3 = await seedTemplate(client, {
        ...t,
        categoryId: tpl,
        thumbnailUrl: 'https://cdn.test/t3.jpg',
      });
      const tGone = await seedTemplate(client, {
        ...t,
        categoryId: tpl,
        thumbnailUrl: 'https://cdn.test/gone.jpg',
        isDeleted: true,
      });
      await setCreatedAt(client, 'media_templates', t1, at(1));
      await setCreatedAt(client, 'media_templates', t2, at(2));
      await setCreatedAt(client, 'media_templates', t3, at(3));
      await setCreatedAt(client, 'media_templates', tGone, at(4));

      const l1 = await seedLink(client, {
        ...t,
        categoryId: lnk,
        previewImageUrl: 'https://cdn.test/l1.jpg',
      });
      const l2 = await seedLink(client, {
        ...t,
        categoryId: lnk,
        previewImageUrl: 'https://cdn.test/l2.jpg',
      });
      await setCreatedAt(client, 'saved_links', l1, at(1));
      await setCreatedAt(client, 'saved_links', l2, at(2));

      await seedSnippet(client, { ...t, categoryId: snp });
      await seedSnippet(client, { ...t, categoryId: snp });

      const rows = await new CategoryService(db).findAll(workspaceId, {
        withStats: true,
      });
      const stats = (id: string) => rows.find((r) => r.id === id)?.stats;
      expect(stats(tpl)).toEqual({
        itemCount: 3,
        bytes: 0,
        covers: ['https://cdn.test/t3.jpg', 'https://cdn.test/t1.jpg'],
      });
      expect(stats(lnk)).toEqual({
        itemCount: 2,
        bytes: 0,
        covers: ['https://cdn.test/l2.jpg', 'https://cdn.test/l1.jpg'],
      });
      expect(stats(snp)).toEqual({ itemCount: 2, bytes: 0, covers: [] });
    });
  });

  it('searches folder names case-insensitively, and adds no stats key unless asked', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const launch = await seedCategory(client, workspaceId, 'media', 'Launch');
      await seedCategory(client, workspaceId, 'media', 'Other');
      await seedCategory(client, workspaceId, 'template', '100% off');

      const svc = new CategoryService(db);
      const found = await svc.findAll(workspaceId, { search: 'lau' });
      expect(found.map((r) => r.id)).toEqual([launch]);
      expect(found[0]).not.toHaveProperty('stats');

      // LIKE wildcards are literal.
      const percent = await svc.findAll(workspaceId, { search: '%' });
      expect(percent.map((r) => r.name)).toEqual(['100% off']);

      const withStats = await svc.findAll(workspaceId, {
        search: 'lau',
        withStats: true,
      });
      expect(withStats.map((r) => r.id)).toEqual([launch]);
      expect(withStats[0].stats).toEqual({
        itemCount: 0,
        bytes: 0,
        covers: [],
      });
    });
  });

  it('keeps the type filter and the display order with stats on', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await seedCategory(client, workspaceId, 'media', 'B');
      await seedCategory(client, workspaceId, 'media', 'A');
      await seedCategory(client, workspaceId, 'link', 'L');
      const rows = await new CategoryService(db).findAll(workspaceId, {
        type: 'media',
        withStats: true,
      });
      expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
      expect(rows[0]).toEqual(
        expect.objectContaining({ workspaceId, type: 'media', name: 'A' }),
      );
    });
  });
});
