import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { mediaItems } from '../../drizzle/schema/media-library.schema';
import type { DbType } from '../../drizzle/db';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { UploadResult } from '../../media/cloudinary.service';
import { StorageFullException } from '../lib/storage';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  makeStorageMocks,
  ownCloudinaryFile,
  ownR2File,
  seedWorkspace,
  seedMediaItem,
  seedUsage,
  TEST_CLOUDINARY_BASE,
} from '../testing/library-db';
import { StorageObjectService } from './storage-object.service';
import { StorageQuotaService } from './storage-quota.service';

const LIMIT = 1000;

/** Real StorageObjectService over provider mocks, so its rules run for real. */
function setup(db: DbType) {
  const { cloudinary, r2 } = makeStorageMocks();
  const storageObjects = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    db,
  );
  const quota = new StorageQuotaService(db);
  const service = makeMediaItemService(db, { storageObjects, quota });
  return { cloudinary, r2, storageObjects, quota, service };
}

/** A workspace with `used` bytes already stored and a limit of 1000. */
async function workspaceUsing(client: PoolClient, used: number) {
  const ws = await seedWorkspace(client);
  await seedUsage(client, ws.workspaceId, { storageBytesLimit: LIMIT });
  if (used > 0) {
    await seedMediaItem(client, {
      workspaceId: ws.workspaceId,
      uploadedById: ws.ownerId,
      fileSize: used,
    });
  }
  return ws;
}

async function countRows(client: PoolClient, workspaceId: string) {
  const r = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM media_items WHERE workspace_id = $1',
    [workspaceId],
  );
  return r.rows[0].n;
}

function cloudinaryUpload(over: Partial<UploadResult> = {}): UploadResult {
  const publicId = over.publicId ?? 'social-media/upload-abc';
  const secureUrl = `${TEST_CLOUDINARY_BASE}/image/upload/v1/${publicId}.png`;
  return {
    publicId,
    url: secureUrl.replace('https:', 'http:'),
    secureUrl,
    format: 'png',
    resourceType: 'image',
    bytes: 100,
    width: 10,
    height: 10,
    ...over,
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describeLibraryDb('MediaItemService.create / createFromUpload storage', () => {
  it('refuses an R2 file whose real size goes over, deletes it, inserts nothing', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 900);
      const { service, r2 } = setup(db);
      r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 200 });
      const file = ownR2File(workspaceId);

      const err = await service
        .create(workspaceId, ownerId, {
          type: 'video',
          name: 'clip',
          ...file,
          fileSize: 1,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StorageFullException);
      expect((err as StorageFullException).getStatus()).toBe(413);
      expect((err as StorageFullException).getResponse()).toEqual({
        code: 'STORAGE_FULL',
        message: expect.any(String) as string,
        used: 900,
        limit: LIMIT,
      });
      expect(r2.deleteObject).toHaveBeenCalledWith(file.cloudinaryPublicId);
      expect(await countRows(client, workspaceId)).toBe(1);
    });
  });

  it('stores the real size, not the declared one', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 0);
      const { service, r2 } = setup(db);
      r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 100 });

      const created = await service.create(workspaceId, ownerId, {
        type: 'video',
        name: 'clip',
        ...ownR2File(workspaceId),
        fileSize: 1,
      });

      expect(created.fileSize).toBe(100);
      expect(created.uploadedBy?.id).toBe(ownerId);
      expect(created.category).toBeNull();
    });
  });

  it('falls back to the declared size when the store cannot tell', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 0);
      const { service, cloudinary } = setup(db);
      cloudinary.getResourceBytes.mockResolvedValue(null);

      const created = await service.create(workspaceId, ownerId, {
        type: 'image',
        name: 'pic',
        ...ownCloudinaryFile(workspaceId),
        fileSize: 321,
      });

      expect(cloudinary.getResourceBytes).toHaveBeenCalled();
      expect(created.fileSize).toBe(321);
    });
  });

  it('an over-limit workspace cannot add, but can still edit, bin, restore and move', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 0);
      const existing = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        fileSize: 1200,
      });
      const { service } = setup(db);

      await expect(
        service.create(workspaceId, ownerId, {
          type: 'image',
          name: 'more',
          ...ownCloudinaryFile(workspaceId),
          fileSize: 10,
        }),
      ).rejects.toBeInstanceOf(StorageFullException);

      await expect(
        service.update(workspaceId, existing, { name: 'renamed' }),
      ).resolves.toMatchObject({ name: 'renamed' });
      await expect(
        service.softDelete(workspaceId, existing, ownerId),
      ).resolves.toMatchObject({ isDeleted: true });
      await expect(
        service.restore(workspaceId, existing),
      ).resolves.toMatchObject({ isDeleted: false });
      await expect(
        service.bulkAction(workspaceId, ownerId, {
          ids: [existing],
          action: 'move',
          categoryId: null,
        } as never),
      ).resolves.toEqual({ affectedCount: 1 });
    });
  });

  // B2: the usage read and the insert both run on the transaction that holds
  // the workspace lock, or two parallel uploads could both pass the check.
  describe('lock order (B2)', () => {
    /**
     * Wraps the real quota service: `runLocked` hands `fn` a recording proxy
     * of its transaction, so a statement sent to `this.db` instead shows up
     * as missing. (The harness runs on one connection, so visibility alone
     * cannot tell the two apart.)
     */
    function spiedQuota(db: DbType) {
      const real = new StorageQuotaService(db);
      const seen = {
        tx: undefined as DbType | undefined,
        txCalls: [] as string[],
        visibleInside: [] as number[],
      };
      const getUsage = jest.spyOn(real, 'getUsage');
      type LockedFn = (tx: DbType) => Promise<unknown>;
      const runLocked = real.runLocked.bind(real) as (
        ws: string,
        fn: LockedFn,
      ) => Promise<unknown>;
      const spied = (ws: string, fn: LockedFn) =>
        runLocked(ws, async (tx: DbType) => {
          const proxy = new Proxy(tx, {
            get(target, prop, receiver) {
              if (typeof prop === 'string') seen.txCalls.push(prop);
              return Reflect.get(target, prop, receiver) as unknown;
            },
          });
          seen.tx = proxy;
          const result = await fn(proxy);
          // The callback yields the new row's id (or the row itself).
          const id =
            typeof result === 'string' ? result : (result as { id: string }).id;
          const rows = await tx
            .select({ id: mediaItems.id })
            .from(mediaItems)
            .where(eq(mediaItems.id, id));
          seen.visibleInside.push(rows.length);
          return result;
        });
      jest
        .spyOn(real, 'runLocked')
        .mockImplementation(spied as typeof real.runLocked);
      return { real, seen, getUsage };
    }

    it('create reads usage and inserts through the locked transaction', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { real, seen, getUsage } = spiedQuota(db);
        const { cloudinary, r2 } = makeStorageMocks();
        const service = makeMediaItemService(db, {
          quota: real,
          storageObjects: new StorageObjectService(
            cloudinary as unknown as CloudinaryService,
            r2 as unknown as CloudflareR2Service,
            db,
          ),
        });

        await service.create(workspaceId, ownerId, {
          type: 'image',
          name: 'pic',
          ...ownCloudinaryFile(workspaceId),
          fileSize: 5,
        });

        expect(seen.tx).toBeDefined();
        expect(getUsage).toHaveBeenCalledWith(workspaceId, seen.tx);
        expect(seen.txCalls).toContain('insert');
        expect(seen.visibleInside).toEqual([1]);
      });
    });

    it('createFromUpload reads usage and inserts through the locked transaction', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { real, seen, getUsage } = spiedQuota(db);
        const { cloudinary, r2 } = makeStorageMocks();
        const service = makeMediaItemService(db, {
          quota: real,
          storageObjects: new StorageObjectService(
            cloudinary as unknown as CloudinaryService,
            r2 as unknown as CloudflareR2Service,
            db,
          ),
        });

        await service.createFromUpload(
          workspaceId,
          ownerId,
          cloudinaryUpload(),
          {
            name: 'pic',
          },
        );

        expect(getUsage).toHaveBeenCalledWith(workspaceId, seen.tx);
        expect(seen.txCalls).toContain('insert');
        expect(seen.visibleInside).toEqual([1]);
      });
    });
  });

  it('createFromUpload over the limit deletes the upload and inserts nothing (B2)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 950);
      const { service, storageObjects } = setup(db);
      const deleteFile = jest.spyOn(storageObjects, 'deleteFile');
      const upload = cloudinaryUpload({ bytes: 100 });

      await expect(
        service.createFromUpload(workspaceId, ownerId, upload, { name: 'pic' }),
      ).rejects.toBeInstanceOf(StorageFullException);

      expect(deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          storageProvider: 'cloudinary',
          cloudinaryPublicId: upload.publicId,
        }),
      );
      expect(await countRows(client, workspaceId)).toBe(1);
    });
  });

  it('createFromUpload maps the upload onto the row', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 0);
      const { service } = setup(db);

      const pdf = await service.createFromUpload(
        workspaceId,
        ownerId,
        cloudinaryUpload({
          publicId: 'social-media/deck',
          format: 'pdf',
          pages: 12,
          bytes: 40,
        }),
        { name: 'deck', mimeType: 'application/pdf', tags: ['launch'] },
      );
      expect(pdf).toMatchObject({
        type: 'document',
        pageCount: 12,
        fileSize: 40,
        storageProvider: 'cloudinary',
        cloudinaryPublicId: 'social-media/deck',
        tags: ['launch'],
      });

      const gif = await service.createFromUpload(
        workspaceId,
        ownerId,
        cloudinaryUpload({
          publicId: 'social-media/anim',
          format: 'gif',
          pages: 30,
        }),
        { name: 'anim' },
      );
      // A GIF's `pages` is its frame count, not a page count.
      expect(gif.type).toBe('gif');
      expect(gif.pageCount).toBeNull();
      expect(gif.thumbnailUrl).toBe(gif.fileUrl);
    });
  });

  describe('idempotency (B3)', () => {
    it('create twice with one public id makes one row and skips the size lookup', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { service, cloudinary } = setup(db);
        const file = ownCloudinaryFile(workspaceId);
        const dto = { type: 'image' as const, name: 'pic', ...file };

        const first = await service.create(workspaceId, ownerId, dto);
        cloudinary.getResourceBytes.mockClear();
        const second = await service.create(workspaceId, ownerId, dto);

        expect(second.id).toBe(first.id);
        expect(cloudinary.getResourceBytes).not.toHaveBeenCalled();
        expect(await countRows(client, workspaceId)).toBe(1);
      });
    });

    it('createFromUpload then create with the same fileUrl makes one row', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { service } = setup(db);
        const upload = cloudinaryUpload();

        const first = await service.createFromUpload(
          workspaceId,
          ownerId,
          upload,
          { name: 'pic' },
        );
        const second = await service.create(workspaceId, ownerId, {
          type: 'image',
          name: 'pic',
          fileUrl: upload.secureUrl,
        });

        expect(second.id).toBe(first.id);
        expect(await countRows(client, workspaceId)).toBe(1);
      });
    });

    it('a 413 leaves a file alone while another row still uses it', async () => {
      await withLibraryDb(async (db, client) => {
        const a = await workspaceUsing(client, 0);
        const b = await workspaceUsing(client, 900);
        const file = ownR2File(b.workspaceId);
        // Row A (another workspace) already points at the same file.
        await seedMediaItem(client, {
          workspaceId: a.workspaceId,
          uploadedById: a.ownerId,
          fileUrl: file.fileUrl,
          storageProvider: 'r2',
        });
        const { service, storageObjects, r2 } = setup(db);
        r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 200 });
        const deleteFile = jest.spyOn(storageObjects, 'deleteFile');

        await expect(
          service.create(b.workspaceId, b.ownerId, {
            type: 'video',
            name: 'clip',
            ...file,
          }),
        ).rejects.toBeInstanceOf(StorageFullException);

        expect(deleteFile).not.toHaveBeenCalled();
        expect(r2.deleteObject).not.toHaveBeenCalled();
      });
    });
  });

  it('refuses a file this workspace did not store (SEC5) and deletes nothing', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await workspaceUsing(client, 0);
      const b = await workspaceUsing(client, 0);
      const { service, storageObjects } = setup(db);
      const deleteFile = jest.spyOn(storageObjects, 'deleteFile');

      for (const file of [
        ownR2File(a.workspaceId),
        ownCloudinaryFile(a.workspaceId),
        { fileUrl: 'https://evil.test/x.png', cloudinaryPublicId: undefined },
      ]) {
        await expect(
          service.create(b.workspaceId, b.ownerId, {
            type: 'image',
            name: 'x',
            ...file,
          }),
        ).rejects.toThrow('uploaded to this workspace');
      }
      expect(deleteFile).not.toHaveBeenCalled();
      expect(await countRows(client, b.workspaceId)).toBe(0);
    });
  });
});
