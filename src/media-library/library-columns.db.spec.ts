import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CloudinaryService } from '../media/cloudinary.service';
import type { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { PLAN_STORAGE_BYTES } from '../billing/plan-storage';
import {
  applyMigrationAgain,
  describeLibraryDb,
  makeMediaItemService,
  seedCategory,
  seedMediaItem,
  seedSnippet,
  seedSubscription,
  seedUsage,
  seedWorkspace,
  withLibraryDb,
} from './testing/library-db';
import { StorageObjectService } from './services/storage-object.service';

const MIGRATION = '0054_library_columns.sql';
const R2_BASE = 'https://pub-x.r2.dev';
const DAY_MS = 24 * 60 * 60 * 1000;

async function storageLimit(
  client: PoolClient,
  workspaceId: string,
): Promise<{ limit: number; extra: number }> {
  const r = await client.query<{ limit: string; extra: string }>(
    `SELECT storage_bytes_limit AS limit, extra_storage_purchased AS extra
       FROM workspace_usage WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { limit: Number(r.rows[0].limit), extra: Number(r.rows[0].extra) };
}

async function folders(client: PoolClient, workspaceId: string) {
  const r = await client.query<{
    id: string;
    name: string;
    type: string;
    display_order: number;
  }>(
    `SELECT id, name, type, display_order FROM media_categories
      WHERE workspace_id = $1 ORDER BY type, display_order, name`,
    [workspaceId],
  );
  return r.rows;
}

const shape = (rows: { name: string; type: string; display_order: number }[]) =>
  rows.map((f) => ({
    name: f.name,
    type: f.type,
    display_order: f.display_order,
  }));

describeLibraryDb('migration 0054 (library columns)', () => {
  it('writes per-plan storage and backfills each workspace from its owner’s ACTIVE plan', async () => {
    await withLibraryDb(async (_db, client) => {
      for (const code of Object.keys(PLAN_STORAGE_BYTES)) {
        await client.query(
          `INSERT INTO plans
             (code, name, base_price_cents, channels_per_workspace,
              members_per_workspace, max_workspaces)
           VALUES ($1, $1, 0, 3, 1, 1)
           ON CONFLICT (code) DO NOTHING`,
          [code],
        );
      }
      // Undo what the harness's own applies wrote, so the re-apply must write it.
      await client.query(`UPDATE plans SET storage_bytes_per_workspace = 1`);

      const active = await seedWorkspace(client);
      await seedSubscription(client, active.ownerId, 'PRO', 'active');
      await seedUsage(client, active.workspaceId);

      const canceled = await seedWorkspace(client);
      await seedSubscription(client, canceled.ownerId, 'PRO', 'canceled');
      await seedUsage(client, canceled.workspaceId, { storageBytesLimit: 7 });

      const none = await seedWorkspace(client);
      await seedUsage(client, none.workspaceId, { storageBytesLimit: 7 });

      const extra = await seedWorkspace(client);
      await seedSubscription(client, extra.ownerId, 'MAX', 'active');
      await seedUsage(client, extra.workspaceId, {
        storageBytesLimit: 7,
        extraStoragePurchased: 5,
      });

      await applyMigrationAgain(client, MIGRATION);

      const plans = await client.query<{ code: string; bytes: string }>(
        `SELECT code, storage_bytes_per_workspace AS bytes FROM plans
          WHERE code = ANY($1)`,
        [Object.keys(PLAN_STORAGE_BYTES)],
      );
      expect(
        Object.fromEntries(plans.rows.map((p) => [p.code, Number(p.bytes)])),
      ).toEqual(PLAN_STORAGE_BYTES);

      expect(await storageLimit(client, active.workspaceId)).toEqual({
        limit: 10737418240,
        extra: 0,
      });
      expect(await storageLimit(client, canceled.workspaceId)).toEqual({
        limit: 524288000,
        extra: 0,
      });
      expect(await storageLimit(client, none.workspaceId)).toEqual({
        limit: 524288000,
        extra: 0,
      });
      expect(await storageLimit(client, extra.workspaceId)).toEqual({
        limit: 26843545600,
        extra: 5,
      });
    });
  });

  it('marks legacy composer videos stored on R2 as r2 and rejects unknown providers', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const r2Id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        cloudinaryPublicId: 'composer/videos/w/u/1-a.mp4',
        fileUrl: `${R2_BASE}/composer/videos/w/u/1-a.mp4`,
      });
      const cldId = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        cloudinaryPublicId: 'composer/canva/abc',
        fileUrl:
          'https://res.cloudinary.com/demo/image/upload/v1/composer/canva/abc.png',
      });

      await applyMigrationAgain(client, MIGRATION);

      const r = await client.query<{ id: string; storage_provider: string }>(
        `SELECT id, storage_provider FROM media_items WHERE id = ANY($1)`,
        [[r2Id, cldId]],
      );
      const byId = Object.fromEntries(
        r.rows.map((row) => [row.id, row.storage_provider]),
      );
      expect(byId).toEqual({ [r2Id]: 'r2', [cldId]: 'cloudinary' });

      await client.query('SAVEPOINT bad_provider');
      await expect(
        client.query(
          `UPDATE media_items SET storage_provider = 's3' WHERE id = $1`,
          [cldId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT bad_provider');
    });
  });

  it('renames bio snippets to signature', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const id = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        snippetType: 'bio',
      });

      await applyMigrationAgain(client, MIGRATION);

      const r = await client.query<{ snippet_type: string }>(
        `SELECT snippet_type FROM text_snippets WHERE id = $1`,
        [id],
      );
      expect(r.rows[0].snippet_type).toBe('signature');
    });
  });

  it('merges legacy media folders into one media kind without name clashes', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const now = Date.now();
      await seedCategory(
        client,
        workspaceId,
        'image',
        'Launch',
        new Date(now - 3 * DAY_MS),
      );
      const videoFolder = await seedCategory(
        client,
        workspaceId,
        'video',
        'Launch',
        new Date(now - DAY_MS),
      );
      await seedCategory(client, workspaceId, 'gif', 'Loops');
      await seedCategory(client, workspaceId, 'document', 'Specs');
      await seedCategory(client, workspaceId, 'template', 'T');
      await seedCategory(client, workspaceId, 'link', 'L');
      const itemId = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        categoryId: videoFolder,
      });

      await applyMigrationAgain(client, MIGRATION);

      const expected = [
        { name: 'L', type: 'link', display_order: 0 },
        { name: 'Launch', type: 'media', display_order: 0 },
        { name: 'Loops', type: 'media', display_order: 1 },
        { name: 'Launch (Videos)', type: 'media', display_order: 2 },
        { name: 'Specs', type: 'media', display_order: 3 },
        { name: 'T', type: 'template', display_order: 0 },
      ];
      const after = await folders(client, workspaceId);
      expect(shape(after)).toEqual(expected);
      expect(after.find((f) => f.name === 'Launch (Videos)')?.id).toBe(
        videoFolder,
      );

      const item = await client.query<{ category_id: string }>(
        `SELECT category_id FROM media_items WHERE id = $1`,
        [itemId],
      );
      expect(item.rows[0].category_id).toBe(videoFolder);

      await applyMigrationAgain(client, MIGRATION);
      const third = await folders(client, workspaceId);
      expect(shape(third)).toEqual(expected);
    });
  });

  it('indexes the columns the cross-workspace share query filters on (SEC3)', async () => {
    await withLibraryDb(async (_db, client) => {
      const r = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'media_items'
            AND indexname IN ('media_items_file_url_idx',
                              'media_items_cloudinary_public_id_idx')
          ORDER BY indexname`,
      );
      expect(r.rows.map((x) => x.indexname)).toEqual([
        'media_items_cloudinary_public_id_idx',
        'media_items_file_url_idx',
      ]);
    });
  });

  it('MediaItemService.create records the storage provider', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const cloudinary = {
        delete: jest.fn().mockResolvedValue(true),
        isOwnUrl: jest.fn().mockReturnValue(false),
      };
      const r2 = {
        deleteObject: jest.fn().mockResolvedValue(undefined),
        keyFromPublicUrl: jest.fn((url: string) =>
          url.startsWith(`${R2_BASE}/`) ? url.slice(R2_BASE.length + 1) : null,
        ),
        isOwnUrl: jest.fn().mockReturnValue(false),
      };
      const storageObjects = new StorageObjectService(
        cloudinary as unknown as CloudinaryService,
        r2 as unknown as CloudflareR2Service,
        db,
      );
      const service = makeMediaItemService(db, { storageObjects });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const key = `composer/videos/${workspaceId}/u/1-a.mp4`;

      const created = await service.create(workspaceId, ownerId, {
        type: 'video',
        name: 'clip.mp4',
        fileUrl: `${R2_BASE}/${key}`,
        cloudinaryPublicId: key,
      });

      const r = await client.query<{ storage_provider: string }>(
        `SELECT storage_provider FROM media_items WHERE id = $1`,
        [created.id],
      );
      expect(r.rows[0].storage_provider).toBe('r2');
    });
  });
});
