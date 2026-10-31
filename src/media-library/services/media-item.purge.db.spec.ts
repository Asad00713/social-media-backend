import { BadGatewayException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedPost,
  seedCampaignSlot,
} from '../testing/library-db';
import { StorageObjectService } from './storage-object.service';
import type { DbType } from '../../drizzle/db';
import { inArray } from 'drizzle-orm';
import { mediaItems } from '../../drizzle/schema/media-library.schema';

const R2_BASE = 'https://pub.r2.dev';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A key shaped like the ones CloudflareR2Service issues. */
function r2Key(workspaceId: string): string {
  const hex = Math.random().toString(16).slice(2).padEnd(24, '0').slice(0, 24);
  return `composer/videos/${workspaceId}/user-1/${Date.now()}-${hex}.mp4`;
}

function setup(db: DbType) {
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
  const storage = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    db,
  );
  const deleteFile = jest.spyOn(storage, 'deleteFile');
  const service = makeMediaItemService(db, { storageObjects: storage });
  return { cloudinary, r2, storage, deleteFile, service };
}

async function rowExists(client: PoolClient, id: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM media_items WHERE id = $1', [id]);
  return r.rowCount === 1;
}

describeLibraryDb('MediaItemService permanent delete', () => {
  it('purgeItems deletes only rows whose file deletion succeeded', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, r2 } = setup(db);
      const base = {
        workspaceId,
        uploadedById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      };
      const r2Id = await seedMediaItem(client, {
        ...base,
        type: 'video',
        fileUrl: `${R2_BASE}/${r2Key(workspaceId)}`,
      });
      const cldId = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: 'social-media/one',
      });
      r2.deleteObject.mockRejectedValue(new Error('r2 down'));

      const rows = await db
        .select()
        .from(mediaItems)
        .where(inArray(mediaItems.id, [r2Id, cldId]));
      const result = await service.purgeItems(rows);

      expect(result).toEqual({ deletedIds: [cldId], failedIds: [r2Id] });
      expect(await rowExists(client, r2Id)).toBe(true);
      expect(await rowExists(client, cldId)).toBe(false);
    });
  });

  it('permanentDelete removes an R2 file by key and the row', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, r2, cloudinary } = setup(db);
      const key = r2Key(workspaceId);
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        isDeleted: true,
        deletedAt: new Date(),
        fileUrl: `${R2_BASE}/${key}`,
      });
      // The legacy / deploy-window shape: no public id, and the column left
      // at its 'cloudinary' default. Only deleteFile's R2-URL fallback finds
      // the object.
      const legacy = await client.query<{
        storage_provider: string;
        cloudinary_public_id: string | null;
      }>(
        'SELECT storage_provider, cloudinary_public_id FROM media_items WHERE id = $1',
        [id],
      );
      expect(legacy.rows[0]).toEqual({
        storage_provider: 'cloudinary',
        cloudinary_public_id: null,
      });

      await service.permanentDelete(workspaceId, id);

      expect(r2.deleteObject).toHaveBeenCalledWith(key);
      expect(cloudinary.delete).not.toHaveBeenCalled();
      expect(await rowExists(client, id)).toBe(false);
    });
  });

  it('permanentDelete throws BadGateway and keeps the row when storage refuses', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, r2 } = setup(db);
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        isDeleted: true,
        deletedAt: new Date(),
        fileUrl: `${R2_BASE}/${r2Key(workspaceId)}`,
      });
      r2.deleteObject.mockRejectedValue(new Error('r2 down'));

      await expect(service.permanentDelete(workspaceId, id)).rejects.toThrow(
        BadGatewayException,
      );
      expect(await rowExists(client, id)).toBe(true);
    });
  });

  it('cleanupRecycleBin purges only rows deleted over 30 days before now', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service } = setup(db);
      // Far in the past, so no other local row can be older than the cutoff.
      const now = new Date('2001-06-15T12:00:00Z');
      const base = { workspaceId, uploadedById: ownerId, isDeleted: true };
      const old: string[] = [];
      for (let i = 0; i < 3; i++) {
        old.push(
          await seedMediaItem(client, {
            ...base,
            cloudinaryPublicId: `old-${i}-${Date.now()}`,
            deletedAt: new Date(now.getTime() - 31 * DAY_MS),
          }),
        );
      }
      const recent = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: `recent-${Date.now()}`,
        deletedAt: new Date(now.getTime() - DAY_MS),
      });

      const result = await service.cleanupRecycleBin(now);

      expect(result.deletedCount).toBeGreaterThanOrEqual(3);
      for (const id of old) expect(await rowExists(client, id)).toBe(false);
      expect(await rowExists(client, recent)).toBe(true);
    });
  });

  it('purgeDeleted survives rows that fail and keeps going past them', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary } = setup(db);
      await client.query(
        `INSERT INTO media_items
           (workspace_id, uploaded_by_id, type, name, file_url,
            cloudinary_public_id, is_deleted, deleted_at)
         SELECT $1, $2, 'image', 'n' || g, 'https://cdn.example.test/' || g,
                'pid-' || g, true, now()
           FROM generate_series(1, 450) g`,
        [workspaceId, ownerId],
      );
      const ids = (
        await client.query<{ id: string; pid: string }>(
          `SELECT id, cloudinary_public_id AS pid FROM media_items
            WHERE workspace_id = $1 ORDER BY id ASC`,
          [workspaceId],
        )
      ).rows;
      const failing = new Set([ids[0].pid, ids[249].pid]);
      cloudinary.delete.mockImplementation((publicId: string) =>
        failing.has(publicId)
          ? Promise.reject(new Error('refused'))
          : Promise.resolve(true),
      );

      const result = await service.purgeDeleted({ workspaceId });

      expect(result).toEqual({ deleted: 448, failed: 2 });
      const left = await client.query(
        'SELECT id FROM media_items WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(left.rows.map((r: { id: string }) => r.id).sort()).toEqual(
        [ids[0].id, ids[249].id].sort(),
      );
    });
  });

  it('does not delete a file another workspace references; only the row goes', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const fileUrl = `https://cdn.example.test/victim-${Date.now()}.png`;
      const attacker = await seedMediaItem(client, {
        workspaceId: a.workspaceId,
        uploadedById: a.ownerId,
        fileUrl,
        cloudinaryPublicId: 'social-media/victim',
        isDeleted: true,
        deletedAt: new Date(),
      });
      const victim = await seedMediaItem(client, {
        workspaceId: b.workspaceId,
        uploadedById: b.ownerId,
        fileUrl,
        cloudinaryPublicId: 'social-media/victim',
      });

      await service.permanentDelete(a.workspaceId, attacker);

      expect(deleteFile).not.toHaveBeenCalled();
      expect(await rowExists(client, attacker)).toBe(false);
      expect(await rowExists(client, victim)).toBe(true);
    });
  });

  it('treats a row with the same public id but another url as sharing the file', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const publicId = `social-media/pid-${Date.now()}`;
      const attacker = await seedMediaItem(client, {
        workspaceId: a.workspaceId,
        uploadedById: a.ownerId,
        fileUrl: `https://cdn.example.test/attacker-${Date.now()}.png`,
        cloudinaryPublicId: publicId,
        isDeleted: true,
        deletedAt: new Date(),
      });
      const victim = await seedMediaItem(client, {
        workspaceId: b.workspaceId,
        uploadedById: b.ownerId,
        fileUrl: `https://cdn.example.test/victim-${Date.now()}.png`,
        cloudinaryPublicId: publicId,
      });

      await service.permanentDelete(a.workspaceId, attacker);

      expect(deleteFile).not.toHaveBeenCalled();
      expect(await rowExists(client, attacker)).toBe(false);
      expect(await rowExists(client, victim)).toBe(true);
    });
  });

  it('counts a binned row in another workspace as sharing the file', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const fileUrl = `https://cdn.example.test/both-${Date.now()}.png`;
      const mine = await seedMediaItem(client, {
        workspaceId: a.workspaceId,
        uploadedById: a.ownerId,
        fileUrl,
        isDeleted: true,
        deletedAt: new Date(),
      });
      const theirs = await seedMediaItem(client, {
        workspaceId: b.workspaceId,
        uploadedById: b.ownerId,
        fileUrl,
        isDeleted: true,
        deletedAt: new Date(),
      });

      await service.permanentDelete(a.workspaceId, mine);

      expect(deleteFile).not.toHaveBeenCalled();
      expect(await rowExists(client, theirs)).toBe(true);
    });
  });

  it('deletes a file once when two purged rows share only a public id', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const publicId = `social-media/twin-${Date.now()}`;
      const base = {
        workspaceId,
        uploadedById: ownerId,
        cloudinaryPublicId: publicId,
        isDeleted: true,
        deletedAt: new Date(),
      };
      await seedMediaItem(client, {
        ...base,
        fileUrl: `https://cdn.example.test/t1-${Date.now()}.png`,
      });
      await seedMediaItem(client, {
        ...base,
        fileUrl: `https://cdn.example.test/t2-${Date.now()}.png`,
      });

      const result = await service.purgeDeleted({ workspaceId });

      expect(result).toEqual({ deleted: 2, failed: 0 });
      expect(deleteFile).toHaveBeenCalledTimes(1);
    });
  });

  it('does not delete an R2 object that sits under another workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, r2 } = setup(db);
      const id = await seedMediaItem(client, {
        workspaceId: a.workspaceId,
        uploadedById: a.ownerId,
        type: 'video',
        isDeleted: true,
        deletedAt: new Date(),
        fileUrl: `${R2_BASE}/${r2Key(b.workspaceId)}`,
      });

      await service.permanentDelete(a.workspaceId, id);

      expect(r2.deleteObject).not.toHaveBeenCalled();
      expect(await rowExists(client, id)).toBe(false);
    });
  });

  it('keeps the file when another row still uses it, but deletes the row', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const fileUrl = `https://cdn.example.test/shared-${Date.now()}.png`;
      const binned = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        fileUrl,
        cloudinaryPublicId: 'social-media/shared',
        isDeleted: true,
        deletedAt: new Date(),
      });
      const live = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        fileUrl,
        cloudinaryPublicId: 'social-media/shared',
      });

      const result = await service.purgeDeleted({ workspaceId });

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(deleteFile).not.toHaveBeenCalled();
      expect(await rowExists(client, binned)).toBe(false);
      expect(await rowExists(client, live)).toBe(true);
    });
  });
  it('keeps the file of an item a post or campaign slot still uses, but deletes the row (SEC4)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, deleteFile, cloudinary } = setup(db);
      const base = {
        workspaceId,
        uploadedById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      };
      const inPost = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: 'social-media/in-post',
      });
      const inSlotUrl = `https://cdn.example.test/in-slot-${Date.now()}.png`;
      const inSlot = await seedMediaItem(client, {
        ...base,
        fileUrl: inSlotUrl,
        cloudinaryPublicId: 'social-media/in-slot',
      });
      const unused = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: 'social-media/unused',
      });
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + DAY_MS),
        mediaItems: [
          {
            url: 'https://cdn.example.test/copy.png',
            type: 'image',
            libraryItemId: inPost,
          },
        ],
      });
      await seedCampaignSlot(client, {
        workspaceId,
        createdById: ownerId,
        media: [{ id: 'm1', url: inSlotUrl }],
      });

      const rows = await db
        .select()
        .from(mediaItems)
        .where(inArray(mediaItems.id, [inPost, inSlot, unused]));
      const result = await service.purgeItems(rows);

      expect(result.failedIds).toEqual([]);
      expect([...result.deletedIds].sort()).toEqual(
        [inPost, inSlot, unused].sort(),
      );
      for (const id of [inPost, inSlot, unused]) {
        expect(await rowExists(client, id)).toBe(false);
      }
      // Only the unreferenced item loses its bytes.
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: unused }),
      );
      expect(cloudinary.delete).toHaveBeenCalledTimes(1);
      expect(cloudinary.delete).toHaveBeenCalledWith(
        'social-media/unused',
        'image',
      );
    });
  });

  it('keeps a row restored while its purge was running', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const base = {
        workspaceId,
        uploadedById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      };
      const restored = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: 'social-media/restored',
      });
      const purged = await seedMediaItem(client, {
        ...base,
        cloudinaryPublicId: 'social-media/purged',
      });
      const rows = await db
        .select()
        .from(mediaItems)
        .where(inArray(mediaItems.id, [restored, purged]));
      // A restore lands after the rows were read, while files are deleting.
      deleteFile.mockImplementation(async () => {
        await client.query(
          `UPDATE media_items
              SET is_deleted = false, deleted_at = NULL, deleted_by_id = NULL
            WHERE id = $1`,
          [restored],
        );
      });

      const result = await service.purgeItems(rows);

      expect(result).toEqual({ deletedIds: [purged], failedIds: [] });
      expect(await rowExists(client, restored)).toBe(true);
      expect(await rowExists(client, purged)).toBe(false);
    });
  });

  it('permanentDelete refuses a live item and leaves its file alone', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, deleteFile } = setup(db);
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        cloudinaryPublicId: 'social-media/live',
      });

      await expect(service.permanentDelete(workspaceId, id)).rejects.toThrow(
        NotFoundException,
      );
      expect(deleteFile).not.toHaveBeenCalled();
      expect(await rowExists(client, id)).toBe(true);
    });
  });
});
