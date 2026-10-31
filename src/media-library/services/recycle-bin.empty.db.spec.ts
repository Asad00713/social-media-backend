import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedTemplate,
  seedLink,
} from '../testing/library-db';
import { MediaLibraryController } from '../media-library.controller';
import { CategoryService } from './category.service';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';
import { RecycleBinService } from './recycle-bin.service';
import type { StorageObjectService } from './storage-object.service';

function setup(db: DbType) {
  const deleteFile = jest.fn().mockResolvedValue(undefined);
  const storageObjects = {
    deleteFile,
    isFileShared: jest.fn().mockResolvedValue(false),
  } as unknown as StorageObjectService;
  const media = makeMediaItemService(db, { storageObjects });
  const recycleBin = new RecycleBinService(db, media);
  const controller = new MediaLibraryController(
    new CategoryService(db),
    media,
    new TemplateService(db),
    new TextSnippetService(db),
    new SavedLinkService(db),
    recycleBin,
  );
  return { deleteFile, media, recycleBin, controller };
}

async function seedBulkDeleted(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  mediaCount: number,
  snippetCount: number,
  tag: string,
) {
  await client.query(
    `INSERT INTO media_items
       (workspace_id, uploaded_by_id, type, name, file_url,
        cloudinary_public_id, is_deleted, deleted_at)
     SELECT $1, $2, 'image', 'm' || g, 'https://cdn.example.test/' || $3 || g,
            $3 || '-pid-' || g, true, now()
       FROM generate_series(1, $4::int) g`,
    [workspaceId, userId, tag, mediaCount],
  );
  await client.query(
    `INSERT INTO text_snippets
       (workspace_id, created_by_id, name, snippet_type, content,
        is_deleted, deleted_at)
     SELECT $1, $2, 's' || g, 'caption', 'text', true, now()
       FROM generate_series(1, $3::int) g`,
    [workspaceId, userId, snippetCount],
  );
}

async function count(
  client: PoolClient,
  table: string,
  workspaceId: string,
  deleted?: boolean,
): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}
      WHERE workspace_id = $1 ${
        deleted === undefined ? '' : `AND is_deleted = ${deleted}`
      }`,
    [workspaceId],
  );
  return r.rows[0].n;
}

describeLibraryDb('recycle bin: type filter and empty', () => {
  it('filters by type before paging', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { controller } = setup(db);
      const base = { workspaceId, uploadedById: ownerId, isDeleted: true };
      const t0 = Date.now() - 10 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        await seedMediaItem(client, {
          ...base,
          type: 'video',
          deletedAt: new Date(t0 + i * 1000),
        });
      }
      for (let i = 0; i < 60; i++) {
        await seedMediaItem(client, {
          ...base,
          type: 'image',
          deletedAt: new Date(t0 + 60_000 + i * 1000),
        });
      }

      const result = (await controller.getRecycleBin(workspaceId, {
        type: 'video',
        limit: 50,
      })) as {
        mediaItems: { items: { type: string }[]; total: number };
      };

      expect(result.mediaItems.items).toHaveLength(3);
      expect(result.mediaItems.total).toBe(3);
      expect(result.mediaItems.items.every((i) => i.type === 'video')).toBe(
        true,
      );
    });
  });

  it('empties every kind with no cap and leaves other rows alone', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const { recycleBin } = setup(db);

      await seedBulkDeleted(client, workspaceId, ownerId, 1203, 1001, 'a');
      const del = { isDeleted: true, deletedAt: new Date() };
      for (let i = 0; i < 2; i++) {
        await seedTemplate(client, {
          workspaceId,
          createdById: ownerId,
          ...del,
        });
      }
      for (let i = 0; i < 3; i++) {
        await seedLink(client, { workspaceId, createdById: ownerId, ...del });
      }
      const live = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      await seedBulkDeleted(
        client,
        other.workspaceId,
        other.ownerId,
        5,
        5,
        'b',
      );

      const result = await recycleBin.empty(workspaceId);

      expect(result).toEqual({ deleted: 2209 });
      for (const table of [
        'media_items',
        'media_templates',
        'text_snippets',
        'saved_links',
      ]) {
        expect(await count(client, table, workspaceId, true)).toBe(0);
      }
      const liveRow = await client.query(
        'SELECT 1 FROM media_items WHERE id = $1',
        [live],
      );
      expect(liveRow.rowCount).toBe(1);
      expect(await count(client, 'media_items', other.workspaceId, true)).toBe(
        5,
      );
      expect(
        await count(client, 'text_snippets', other.workspaceId, true),
      ).toBe(5);
    });
  });

  it('keeps rows whose file will not delete and finishes them on a retry', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { recycleBin, deleteFile } = setup(db);
      await seedBulkDeleted(client, workspaceId, ownerId, 10, 4, 'c');
      const ids = (
        await client.query<{ id: string; pid: string }>(
          `SELECT id, cloudinary_public_id AS pid FROM media_items
            WHERE workspace_id = $1 ORDER BY id`,
          [workspaceId],
        )
      ).rows;
      const failing = new Set([ids[1].pid, ids[7].pid]);
      deleteFile.mockImplementation((ref: { cloudinaryPublicId: string }) =>
        failing.has(ref.cloudinaryPublicId)
          ? Promise.reject(new Error('refused'))
          : Promise.resolve(),
      );

      const first = await recycleBin.empty(workspaceId);
      expect(first).toEqual({ deleted: 8 + 4 });
      const left = await client.query<{ id: string }>(
        'SELECT id FROM media_items WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(left.rows.map((r) => r.id).sort()).toEqual(
        [ids[1].id, ids[7].id].sort(),
      );

      deleteFile.mockResolvedValue(undefined);
      expect(await recycleBin.empty(workspaceId)).toEqual({ deleted: 2 });
      expect(await count(client, 'media_items', workspaceId)).toBe(0);
    });
  });

  it('terminates when every file deletion fails', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { recycleBin, deleteFile } = setup(db);
      await seedBulkDeleted(client, workspaceId, ownerId, 450, 7, 'd');
      deleteFile.mockRejectedValue(new Error('storage down'));

      const result = await recycleBin.empty(workspaceId);

      expect(result).toEqual({ deleted: 7 });
      expect(await count(client, 'media_items', workspaceId, true)).toBe(450);
    });
  });
});
