import { BadRequestException, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { mediaItems } from '../../drizzle/schema/media-library.schema';
import type { DbType } from '../../drizzle/db';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { StorageFullException } from '../lib/storage';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  makeStorageMocks,
  ownCloudinaryFile,
  ownPoster,
  ownR2File,
  seedWorkspace,
  seedMediaItem,
  seedTemplate,
  seedUsage,
  TEST_CLOUDINARY_BASE,
} from '../testing/library-db';
import { StorageObjectService } from './storage-object.service';

/** Real StorageObjectService over provider mocks, so its rules run for real. */
function setup(db: DbType) {
  const { cloudinary, r2 } = makeStorageMocks();
  const storageObjects = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    db,
  );
  const service = makeMediaItemService(db, { storageObjects });
  return { cloudinary, r2, storageObjects, service };
}

async function rowExists(client: PoolClient, id: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM media_items WHERE id = $1', [id]);
  return r.rowCount === 1;
}

/** A binned R2 video whose poster is `posterUrl`. */
async function seedBinnedVideo(
  client: PoolClient,
  workspaceId: string,
  uploadedById: string,
  posterUrl: string | null,
): Promise<string> {
  const file = ownR2File(workspaceId);
  return seedMediaItem(client, {
    workspaceId,
    uploadedById,
    type: 'video',
    fileUrl: file.fileUrl,
    cloudinaryPublicId: file.cloudinaryPublicId,
    storageProvider: 'r2',
    thumbnailUrl: posterUrl,
    isDeleted: true,
    deletedAt: new Date(),
  });
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describeLibraryDb('POST items thumbnailUrl (M6)', () => {
  it("accepts null or a poster under this workspace's library-thumbs/", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service } = setup(db);
      const poster = ownPoster(workspaceId);

      const withPoster = await service.create(workspaceId, ownerId, {
        type: 'video',
        name: 'clip',
        ...ownR2File(workspaceId),
        thumbnailUrl: poster.url,
      });
      const withNull = await service.create(workspaceId, ownerId, {
        type: 'image',
        name: 'pic',
        ...ownCloudinaryFile(workspaceId),
        thumbnailUrl: null as unknown as string,
      });

      expect(withPoster.thumbnailUrl).toBe(poster.url);
      expect(withNull.thumbnailUrl).toBeNull();
    });
  });

  it('refuses any other thumbnailUrl with 400 and saves nothing', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service } = setup(db);
      const inUploadFolder = ownCloudinaryFile(b.workspaceId).fileUrl;
      const bad = [
        'https://evil.test/poster.jpg',
        ownPoster(a.workspaceId).url, // another workspace's poster
        inUploadFolder, // a Library upload, not a poster
        ownR2File(b.workspaceId).fileUrl, // posters never live in R2
        `${TEST_CLOUDINARY_BASE}/image/upload/c_fill,w_10/library-thumbs/${b.workspaceId}/x.jpg`,
        `${TEST_CLOUDINARY_BASE}/image/upload/v1/library-thumbs/${b.workspaceId}/../x.jpg`,
        '',
      ];

      for (const thumbnailUrl of bad) {
        const err = await service
          .create(b.workspaceId, b.ownerId, {
            type: 'video',
            name: 'clip',
            ...ownR2File(b.workspaceId),
            thumbnailUrl,
          })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
      }
      const r = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM media_items WHERE workspace_id = $1',
        [b.workspaceId],
      );
      expect(r.rows[0].n).toBe(0);
    });
  });
});

describeLibraryDb('video posters (M5)', () => {
  it('a 413 on a video save discards the poster it uploaded', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seedUsage(client, workspaceId, { storageBytesLimit: 10 });
      const { service, r2, cloudinary } = setup(db);
      r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 50 });
      const poster = ownPoster(workspaceId);

      await expect(
        service.create(workspaceId, ownerId, {
          type: 'video',
          name: 'clip',
          ...ownR2File(workspaceId),
          thumbnailUrl: poster.url,
        }),
      ).rejects.toBeInstanceOf(StorageFullException);

      expect(cloudinary.delete).toHaveBeenCalledWith(poster.publicId, 'image');
    });
  });

  it('a 413 keeps a poster another row still shows', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seedUsage(client, workspaceId, { storageBytesLimit: 10 });
      const { service, r2, cloudinary } = setup(db);
      r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 50 });
      const poster = ownPoster(workspaceId);
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        thumbnailUrl: poster.url,
      });

      await expect(
        service.create(workspaceId, ownerId, {
          type: 'video',
          name: 'clip',
          ...ownR2File(workspaceId),
          thumbnailUrl: poster.url,
        }),
      ).rejects.toBeInstanceOf(StorageFullException);

      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });

  it('purging a video deletes its unshared poster', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary, r2 } = setup(db);
      const poster = ownPoster(workspaceId);
      const id = await seedBinnedVideo(
        client,
        workspaceId,
        ownerId,
        poster.url,
      );

      await service.permanentDelete(workspaceId, id);

      expect(await rowExists(client, id)).toBe(false);
      expect(r2.deleteObject).toHaveBeenCalledTimes(1);
      expect(cloudinary.delete).toHaveBeenCalledWith(poster.publicId, 'image');
    });
  });

  it('keeps the poster of a video whose purge failed (the row stays)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary, r2 } = setup(db);
      r2.deleteObject.mockRejectedValue(new Error('r2 down'));
      const poster = ownPoster(workspaceId);
      const id = await seedBinnedVideo(
        client,
        workspaceId,
        ownerId,
        poster.url,
      );

      await expect(service.permanentDelete(workspaceId, id)).rejects.toThrow();

      expect(await rowExists(client, id)).toBe(true);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });

  it('keeps a poster another row or a template still shows', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary } = setup(db);
      const shared = ownPoster(workspaceId);
      const inTemplate = ownPoster(workspaceId);
      const v1 = await seedBinnedVideo(
        client,
        workspaceId,
        ownerId,
        shared.url,
      );
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'video',
        thumbnailUrl: shared.url,
      });
      const v2 = await seedBinnedVideo(
        client,
        workspaceId,
        ownerId,
        inTemplate.url,
      );
      await seedTemplate(client, {
        workspaceId,
        createdById: ownerId,
        thumbnailUrl: inTemplate.url,
      });

      const rows = await db
        .select()
        .from(mediaItems)
        .where(inArray(mediaItems.id, [v1, v2]));
      const r = await service.purgeItems(rows);

      expect([...r.deletedIds].sort()).toEqual([v1, v2].sort());
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });

  it('fails closed: a poster whose reference check throws is kept', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary, storageObjects } = setup(db);
      const poster = ownPoster(workspaceId);
      const id = await seedBinnedVideo(
        client,
        workspaceId,
        ownerId,
        poster.url,
      );
      jest
        .spyOn(storageObjects, 'isFileReferenced')
        .mockRejectedValue(new Error('db down'));

      await service.permanentDelete(workspaceId, id);

      expect(await rowExists(client, id)).toBe(false);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });

  it('never deletes a thumbnail outside library-thumbs/<ws>/', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, cloudinary } = setup(db);
      const foreign = ownPoster(b.workspaceId).url;
      const inUploads = ownCloudinaryFile(a.workspaceId).fileUrl;
      const ids = [
        await seedBinnedVideo(client, a.workspaceId, a.ownerId, foreign),
        await seedBinnedVideo(client, a.workspaceId, a.ownerId, inUploads),
      ];

      const rows = await db
        .select()
        .from(mediaItems)
        .where(inArray(mediaItems.id, ids));
      await service.purgeItems(rows);

      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });
});
