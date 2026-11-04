import type { PoolClient } from 'pg';
import type { DbType } from '../../planner/testing/rollback-db';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  makeStorageMocks,
  ownCloudinaryFile,
  seedWorkspace,
  seedMediaItem,
} from '../testing/library-db';
import { StorageObjectService } from '../services/storage-object.service';
import { StorageQuotaService } from '../services/storage-quota.service';
import { LibraryStatsService } from '../services/library-stats.service';
import { RecycleBinService } from '../services/recycle-bin.service';
import { CategoryService } from '../services/category.service';
import { TemplateService } from '../services/template.service';
import { TextSnippetService } from '../services/text-snippet.service';
import { SavedLinkService } from '../services/saved-link.service';
import { LibrarySamplesService } from './library-samples.service';
import {
  SAMPLE_FOLDER_NAME,
  SAMPLE_IMAGES,
  SAMPLE_LINK,
  SAMPLE_SNIPPETS,
  SAMPLE_TEMPLATES,
} from './sample-content';

const API = 'https://api.example.test';
const ENV = { API_PUBLIC_URL: API } as NodeJS.ProcessEnv;
const SAMPLE_BYTES = SAMPLE_IMAGES.reduce((s, i) => s + i.bytes, 0);

async function seeded(db: DbType, workspaceId: string) {
  const result = await new LibrarySamplesService(db).seed(workspaceId, ENV);
  expect(result.status).toBe('seeded');
  return result;
}

async function count(client: PoolClient, table: string, workspaceId: string) {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
    [workspaceId],
  );
  return r.rows[0].n;
}

/** Storage mocks plus a real StorageObjectService whose deleteFile is spied. */
function storageSpies(db: DbType) {
  const { cloudinary, r2 } = makeStorageMocks();
  const storageObjects = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    db,
  );
  const deleteFile = jest.spyOn(storageObjects, 'deleteFile');
  const media = makeMediaItemService(db, { storageObjects });
  return { cloudinary, r2, deleteFile, media };
}

describeLibraryDb('migration 0057 (is_sample)', () => {
  it('adds is_sample NOT NULL DEFAULT false to the five Library tables', async () => {
    await withLibraryDb(async (_db, client) => {
      const r = await client.query<{
        table_name: string;
        is_nullable: string;
        column_default: string;
      }>(
        `SELECT table_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE column_name = 'is_sample'
            AND table_name IN ('media_items', 'media_templates', 'text_snippets',
                               'saved_links', 'media_categories')
          ORDER BY table_name`,
      );
      expect(r.rows).toEqual(
        [
          'media_categories',
          'media_items',
          'media_templates',
          'saved_links',
          'text_snippets',
        ].map((table_name) => ({
          table_name,
          is_nullable: 'NO',
          column_default: 'false',
        })),
      );
    });
  });

  it('lets only a sample row have no creator', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const insert = (isSample: boolean) =>
        client.query(
          `INSERT INTO text_snippets (workspace_id, created_by_id, name, snippet_type, content, is_sample)
           VALUES ($1, NULL, 'x', 'caption', 'x', $2)`,
          [workspaceId, isSample],
        );
      await insert(true);
      await client.query('SAVEPOINT before_bad');
      await expect(insert(false)).rejects.toThrow(/text_snippets_creator_chk/);
      await client.query('ROLLBACK TO SAVEPOINT before_bad');
      await client.query('SAVEPOINT before_bad_media');
      await expect(
        client.query(
          `INSERT INTO media_items (workspace_id, uploaded_by_id, type, name, file_url)
           VALUES ($1, NULL, 'image', 'x', 'https://cdn.example.test/x.png')`,
          [workspaceId],
        ),
      ).rejects.toThrow(/media_items_creator_chk/);
      await client.query('ROLLBACK TO SAVEPOINT before_bad_media');
    });
  });
});

describeLibraryDb('LibrarySamplesService.seed', () => {
  it('seeds a Getting started folder per tab and every sample, marked and creatorless', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);

      expect(await seeded(db, workspaceId)).toEqual({
        status: 'seeded',
        media: SAMPLE_IMAGES.length,
        templates: SAMPLE_TEMPLATES.length,
        snippets: SAMPLE_SNIPPETS.length,
        links: 1,
        folders: 4,
      });

      const folders = await new CategoryService(db).findAll(workspaceId);
      expect(
        folders.map((f) => [f.type, f.name, f.isSample, f.createdBy]),
      ).toEqual(
        expect.arrayContaining([
          ['media', SAMPLE_FOLDER_NAME, true, null],
          ['template', SAMPLE_FOLDER_NAME, true, null],
          ['text_snippet', SAMPLE_FOLDER_NAME, true, null],
          ['link', SAMPLE_FOLDER_NAME, true, null],
        ]),
      );
      const folderOf = new Map(folders.map((f) => [f.type, f.id]));

      const media = await makeMediaItemService(db).findAll(workspaceId);
      expect(media.total).toBe(SAMPLE_IMAGES.length);
      for (const img of SAMPLE_IMAGES) {
        const row = media.items.find((i) => i.name === img.name);
        const url = `${API}/static/library-samples/v1/${img.file}`;
        expect(row).toMatchObject({
          isSample: true,
          uploadedById: null,
          uploadedBy: null,
          type: 'image',
          fileUrl: url,
          thumbnailUrl: url,
          mimeType: 'image/png',
          fileSize: img.bytes,
          width: img.width,
          height: img.height,
          altText: img.altText,
          cloudinaryPublicId: null,
          categoryId: folderOf.get('media'),
        });
      }
      const idOfUrl = new Map(media.items.map((i) => [i.fileUrl, i.id]));

      const templates = await new TemplateService(db).findAll(workspaceId);
      expect(templates.items.map((t) => t.name).sort()).toEqual(
        SAMPLE_TEMPLATES.map((t) => t.name).sort(),
      );
      for (const t of templates.items) {
        expect(t).toMatchObject({
          isSample: true,
          createdBy: null,
          categoryId: folderOf.get('template'),
        });
        // Each template carries its image as Library media, linked by id.
        const [attached] = t.content.media ?? [];
        expect(attached.url).toBe(t.thumbnailUrl);
        expect(attached.libraryItemId).toBe(idOfUrl.get(attached.url));
      }

      const snippets = await new TextSnippetService(db).findAll(workspaceId);
      expect(
        snippets.items.map((s) => [s.snippetType, s.isSample, s.createdBy]),
      ).toEqual(
        expect.arrayContaining(
          SAMPLE_SNIPPETS.map((s) => [s.snippetType, true, null]),
        ),
      );

      const links = await new SavedLinkService(db).findAll(workspaceId);
      expect(links.items).toHaveLength(1);
      expect(links.items[0]).toMatchObject({
        isSample: true,
        createdBy: null,
        url: SAMPLE_LINK.url,
        utm: SAMPLE_LINK.utm,
        categoryId: folderOf.get('link'),
      });
    });
  });

  it('points every workspace at the same shared file: no copy per workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      await seeded(db, a.workspaceId);
      await seeded(db, b.workspaceId);

      const urls = await client.query<{ file_url: string; n: number }>(
        `SELECT file_url, count(DISTINCT workspace_id)::int AS n
           FROM media_items WHERE workspace_id = ANY($1) GROUP BY file_url`,
        [[a.workspaceId, b.workspaceId]],
      );
      expect(urls.rows).toHaveLength(SAMPLE_IMAGES.length);
      expect(urls.rows.every((r) => r.n === 2)).toBe(true);
    });
  });

  it('is idempotent: a second run adds nothing', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const svc = new LibrarySamplesService(db);
      await svc.seed(workspaceId, ENV);
      const before = await Promise.all(
        [
          'media_items',
          'media_templates',
          'text_snippets',
          'saved_links',
          'media_categories',
        ].map((t) => count(client, t, workspaceId)),
      );

      expect(await svc.seed(workspaceId, ENV)).toEqual({
        status: 'skipped',
        reason: 'already_seeded',
      });
      // Still skipped once the user has binned some of them.
      await client.query(
        `UPDATE media_items SET is_deleted = true WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect((await svc.seed(workspaceId, ENV)).status).toBe('skipped');

      const after = await Promise.all(
        [
          'media_items',
          'media_templates',
          'text_snippets',
          'saved_links',
          'media_categories',
        ].map((t) => count(client, t, workspaceId)),
      );
      expect(after).toEqual(before);
    });
  });

  it('without a public API URL, seeds everything but the images', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);

      const result = await new LibrarySamplesService(db).seed(
        workspaceId,
        {} as NodeJS.ProcessEnv,
      );

      expect(result).toMatchObject({ status: 'seeded', media: 0, folders: 3 });
      expect(await count(client, 'media_items', workspaceId)).toBe(0);
      const t = await new TemplateService(db).findAll(workspaceId);
      expect(t.items.every((x) => x.thumbnailUrl === null)).toBe(true);
      expect(t.items.every((x) => (x.content.media ?? []).length === 0)).toBe(
        true,
      );
    });
  });

  it('skips a workspace that does not exist', async () => {
    await withLibraryDb(async (db) => {
      expect(
        await new LibrarySamplesService(db).seed(
          '7b0f9c8e-8d36-4a52-9a4c-3f3c3b0f1a11',
          ENV,
        ),
      ).toEqual({ status: 'skipped', reason: 'no_workspace' });
    });
  });
});

describeLibraryDb('samples take no storage', () => {
  it('quota and every byte figure skip samples; counts include them', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seeded(db, workspaceId);
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'image',
        fileSize: 100,
      });
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'image',
        fileSize: 7,
        isDeleted: true,
        deletedAt: new Date(),
      });
      // One sample in the Bin: its bytes must not reach bin.bytes either.
      await client.query(
        `UPDATE media_items SET is_deleted = true, deleted_at = now()
          WHERE id = (SELECT id FROM media_items
                       WHERE workspace_id = $1 AND is_sample LIMIT 1)`,
        [workspaceId],
      );

      const usage = await new StorageQuotaService(db).getUsage(workspaceId);
      expect(usage.used).toBe(107);

      const stats = await new LibraryStatsService(
        db,
        new StorageQuotaService(db),
      ).getStats(workspaceId);
      expect(stats.storage.used).toBe(107);
      expect(stats.storage.byType.images).toBe(100);
      expect(stats.unused.bytes).toBe(100);
      expect(stats.bin.bytes).toBe(7);
      // The rows are real and listed, so the counts include them.
      // Live images: every sample but the binned one, plus the real one.
      expect(stats.counts.media.images).toBe(SAMPLE_IMAGES.length - 1 + 1);
      expect(stats.bin.count).toBe(2);
      expect(SAMPLE_BYTES).toBeGreaterThan(0);
    });
  });
});

describeLibraryDb('a sample file is never deleted', () => {
  /**
   * The hard case: `a` is the only workspace holding the samples, and its
   * templates (which reference four of the images) are gone, so no other row
   * shares or references a sample file and the ordinary share check would
   * let it be deleted. Every sample of `a` is binned, plus one real file.
   */
  async function setup(db: DbType, client: PoolClient, deletedAt?: Date) {
    const a = await seedWorkspace(client);
    await seeded(db, a.workspaceId);
    await client.query(`DELETE FROM media_templates WHERE workspace_id = $1`, [
      a.workspaceId,
    ]);
    await client.query(
      `UPDATE media_items SET is_deleted = true, deleted_at = $2
        WHERE workspace_id = $1`,
      [a.workspaceId, deletedAt ?? new Date()],
    );
    const real = ownCloudinaryFile(a.workspaceId);
    const realId = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      fileUrl: real.fileUrl,
      cloudinaryPublicId: real.cloudinaryPublicId,
      isDeleted: true,
      deletedAt: deletedAt ?? new Date(),
    });
    const sampleIds = (
      await client.query<{ id: string }>(
        `SELECT id FROM media_items WHERE workspace_id = $1 AND is_sample`,
        [a.workspaceId],
      )
    ).rows.map((r) => r.id);
    return { a, real, realId, sampleIds };
  }

  /** `a`'s rows are gone; only the real file was deleted from storage. */
  async function expectOnlyRealFileDeleted(
    client: PoolClient,
    s: Awaited<ReturnType<typeof setup>>,
    deleteFile: jest.SpyInstance,
  ) {
    // Scoped to `a`: the retention purge also sweeps any old binned row the
    // local database holds. The guard is not vacuous: the real file did go.
    const refs = deleteFile.mock.calls.map(
      ([ref]) => ref as { workspaceId: string; fileUrl: string },
    );
    expect(refs.filter((r) => r.workspaceId === s.a.workspaceId)).toEqual([
      expect.objectContaining({
        cloudinaryPublicId: s.real.cloudinaryPublicId,
      }),
    ]);
    expect(
      refs.some((r) => r.fileUrl.includes('/static/library-samples/')),
    ).toBe(false);
    expect(await count(client, 'media_items', s.a.workspaceId)).toBe(0);
  }

  it('delete forever, one at a time', async () => {
    await withLibraryDb(async (db, client) => {
      const s = await setup(db, client);
      const { media, deleteFile } = storageSpies(db);
      for (const id of [...s.sampleIds, s.realId]) {
        await media.permanentDelete(s.a.workspaceId, id);
      }
      await expectOnlyRealFileDeleted(client, s, deleteFile);
    });
  });

  it('bulk permanentDelete', async () => {
    await withLibraryDb(async (db, client) => {
      const s = await setup(db, client);
      const { media, deleteFile } = storageSpies(db);
      await media.bulkAction(s.a.workspaceId, s.a.ownerId, {
        ids: [...s.sampleIds, s.realId],
        action: 'permanentDelete',
      });
      await expectOnlyRealFileDeleted(client, s, deleteFile);
    });
  });

  it('Bin delete forever and empty Bin', async () => {
    await withLibraryDb(async (db, client) => {
      const s = await setup(db, client);
      const { media, deleteFile } = storageSpies(db);
      const bin = new RecycleBinService(db, media);
      await bin.deleteForever(
        s.a.workspaceId,
        s.sampleIds.slice(0, 2).map((id) => ({ kind: 'media' as const, id })),
      );
      await bin.empty(s.a.workspaceId);
      await expectOnlyRealFileDeleted(client, s, deleteFile);
    });
  });

  it('the retention purge', async () => {
    await withLibraryDb(async (db, client) => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const s = await setup(db, client, old);
      const { media, deleteFile } = storageSpies(db);
      await media.cleanupRecycleBin();
      await expectOnlyRealFileDeleted(client, s, deleteFile);
    });
  });

  it("purging one workspace's samples leaves another's rows alone", async () => {
    await withLibraryDb(async (db, client) => {
      const s = await setup(db, client);
      const b = await seedWorkspace(client);
      await seeded(db, b.workspaceId);
      const { media, deleteFile } = storageSpies(db);

      await new RecycleBinService(db, media).empty(s.a.workspaceId);

      await expectOnlyRealFileDeleted(client, s, deleteFile);
      expect(await count(client, 'media_items', b.workspaceId)).toBe(
        SAMPLE_IMAGES.length,
      );
    });
  });

  it('deleting the sample folder keeps its items and touches no file', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await seeded(db, workspaceId);
      const folders = await new CategoryService(db).findAll(workspaceId, {
        type: 'media',
      });
      const { deleteFile } = storageSpies(db);

      await new CategoryService(db).delete(workspaceId, folders[0].id);

      expect(deleteFile).not.toHaveBeenCalled();
      const left = await client.query<{ category_id: string | null }>(
        `SELECT category_id FROM media_items WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(left.rows).toHaveLength(SAMPLE_IMAGES.length);
      expect(left.rows.every((r) => r.category_id === null)).toBe(true);
    });
  });
});

describeLibraryDb('samples in the Bin', () => {
  it('Bin rows carry isSample', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seeded(db, workspaceId);
      for (const t of [
        'media_items',
        'media_templates',
        'text_snippets',
        'saved_links',
      ]) {
        await client.query(
          `UPDATE ${t} SET is_deleted = true, deleted_at = now() WHERE workspace_id = $1`,
          [workspaceId],
        );
      }
      const realId = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      });

      const page = await new RecycleBinService(
        db,
        makeMediaItemService(db),
      ).list(workspaceId, { limit: 100 });

      const real = page.items.find((r) => r.id === realId);
      expect(real?.isSample).toBe(false);
      const samples = page.items.filter((r) => r.id !== realId);
      expect(samples).toHaveLength(
        SAMPLE_IMAGES.length +
          SAMPLE_TEMPLATES.length +
          SAMPLE_SNIPPETS.length +
          1,
      );
      expect(
        samples.every((r) => r.isSample === true && r.createdBy === null),
      ).toBe(true);
    });
  });
});
