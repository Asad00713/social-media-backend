import { randomUUID } from 'crypto';
import { HttpException, Logger } from '@nestjs/common';
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
  seedPost,
  seedCampaignSlot,
  seedEvergreenPost,
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

  // Fix round 1 (overrides the brief's fallback test): the client's fileSize
  // is never the quota. A size the store cannot give refuses the save.
  describe('unknown size', () => {
    async function refused(
      run: (s: ReturnType<typeof setup>, ws: string, user: string) => unknown,
    ) {
      return withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const s = setup(db);
        const deleteFile = jest.spyOn(s.storageObjects, 'deleteFile');
        const err = await Promise.resolve(run(s, workspaceId, ownerId)).catch(
          (e: unknown) => e,
        );
        expect(await countRows(client, workspaceId)).toBe(0);
        expect(deleteFile).not.toHaveBeenCalled();
        return err as HttpException;
      });
    }

    it('an R2 object that is not there yet is 400 Upload not finished', async () => {
      const err = await refused(({ service, r2 }, ws, user) => {
        r2.verifyObject.mockResolvedValue({ exists: false });
        return service.create(ws, user, {
          type: 'video',
          name: 'clip',
          ...ownR2File(ws),
          fileSize: 1,
        });
      });
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toEqual({
        code: 'UPLOAD_NOT_FINISHED',
        message: 'Upload not finished',
      });
    });

    it('a Cloudinary id that does not exist is 400 Upload not finished', async () => {
      const err = await refused(({ service, cloudinary }, ws, user) => {
        cloudinary.getResourceBytes.mockResolvedValue({ kind: 'missing' });
        return service.create(ws, user, {
          type: 'image',
          name: 'pic',
          ...ownCloudinaryFile(ws),
          fileSize: 1,
        });
      });
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: 'UPLOAD_NOT_FINISHED' });
    });

    it('a provider error is a retryable 503', async () => {
      const err = await refused(({ service, cloudinary }, ws, user) => {
        cloudinary.getResourceBytes.mockResolvedValue({ kind: 'error' });
        return service.create(ws, user, {
          type: 'image',
          name: 'pic',
          ...ownCloudinaryFile(ws),
          fileSize: 1,
        });
      });
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({ code: 'SIZE_UNAVAILABLE' });
    });
  });

  it('createFromUpload refuses an existing Cloudinary asset: 409, no row, nothing deleted', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await workspaceUsing(client, 0);
      const { service, storageObjects, cloudinary } = setup(db);
      const deleteFile = jest.spyOn(storageObjects, 'deleteFile');
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const err = (await service
        .createFromUpload(
          workspaceId,
          ownerId,
          cloudinaryUpload({
            publicId: 'library/other/victim',
            existing: true,
          }),
          { name: 'pic' },
        )
        .catch((e: unknown) => e)) as HttpException;

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: 'UPLOAD_CONFLICT' });
      expect(error).toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();
      expect(cloudinary.delete).not.toHaveBeenCalled();
      expect(await countRows(client, workspaceId)).toBe(0);
    });
  });

  // Fix round 2: the 413 guard uses the shared reference builders
  // (usage-sql.ts), scoped to the file's workspace as they define it; R2 and
  // Cloudinary keys already carry that workspace.
  describe('413 spares a file something still references', () => {
    async function overLimitCreate(
      seedRef: (
        client: PoolClient,
        ws: { workspaceId: string; ownerId: string },
        fileUrl: string,
      ) => Promise<unknown>,
    ) {
      await withLibraryDb(async (db, client) => {
        const b = await workspaceUsing(client, 900);
        const file = ownR2File(b.workspaceId);
        await seedRef(client, b, file.fileUrl);
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
    }

    it('a post of the workspace uses its URL (no Library row)', () =>
      overLimitCreate((client, ws, url) =>
        seedPost(client, {
          workspaceId: ws.workspaceId,
          createdById: ws.ownerId,
          mediaItems: [{ url, type: 'video' }],
        }),
      ));

    it('an unmaterialised campaign slot of the workspace uses its URL', () =>
      overLimitCreate((client, ws, url) =>
        seedCampaignSlot(client, {
          workspaceId: ws.workspaceId,
          createdById: ws.ownerId,
          media: [{ id: randomUUID(), url }],
        }),
      ));

    it('an evergreen entry of the workspace uses its URL', () =>
      overLimitCreate((client, ws, url) =>
        seedEvergreenPost(client, {
          workspaceId: ws.workspaceId,
          createdById: ws.ownerId,
          media: [{ id: randomUUID(), url }],
        }),
      ));

    it("some row (any workspace) shows it as its thumbnail_url, e.g. a video's poster", () =>
      overLimitCreate(async (client, _ws, url) => {
        const other = await seedWorkspace(client);
        await seedMediaItem(client, {
          workspaceId: other.workspaceId,
          uploadedById: other.ownerId,
          type: 'video',
          thumbnailUrl: url,
        });
      }));
  });

  // Fix round 2 (Important 1): createFromUpload owns orphan cleanup, and only
  // for a failure before or inside the locked insert. Once the row has
  // committed, its bytes are never an orphan.
  describe('orphan cleanup', () => {
    it('a failure inside the locked insert deletes the fresh upload, then surfaces', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { service, storageObjects, quota } = setup(db);
        const boom = new Error('db down');
        jest.spyOn(quota, 'runLocked').mockRejectedValueOnce(boom);
        const deleteFile = jest.spyOn(storageObjects, 'deleteFile');
        const upload = cloudinaryUpload({ publicId: 'library/ws/orphan' });

        await expect(
          service.createFromUpload(workspaceId, ownerId, upload, {
            name: 'pic',
          }),
        ).rejects.toBe(boom);

        expect(deleteFile).toHaveBeenCalledWith(
          expect.objectContaining({ cloudinaryPublicId: 'library/ws/orphan' }),
        );
        expect(await countRows(client, workspaceId)).toBe(0);
      });
    });

    it('never deletes a fresh upload something already references', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const upload = cloudinaryUpload({ publicId: 'library/ws/shared' });
        await seedMediaItem(client, {
          workspaceId,
          uploadedById: ownerId,
          type: 'video',
          thumbnailUrl: upload.secureUrl,
        });
        const { service, storageObjects, quota } = setup(db);
        jest.spyOn(quota, 'runLocked').mockRejectedValueOnce(new Error('x'));
        const deleteFile = jest.spyOn(storageObjects, 'deleteFile');

        await expect(
          service.createFromUpload(workspaceId, ownerId, upload, {
            name: 'pic',
          }),
        ).rejects.toThrow('x');

        expect(deleteFile).not.toHaveBeenCalled();
      });
    });

    it('a failure after the insert committed deletes nothing; the row stays and the error surfaces', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await workspaceUsing(client, 0);
        const { service, storageObjects, cloudinary } = setup(db);
        const readFailed = new Error('read failed');
        jest
          .spyOn(
            service as unknown as { viewOf: (id: string) => Promise<unknown> },
            'viewOf',
          )
          .mockRejectedValueOnce(readFailed);
        const deleteFile = jest.spyOn(storageObjects, 'deleteFile');
        const isFileShared = jest.spyOn(storageObjects, 'isFileShared');

        await expect(
          service.createFromUpload(workspaceId, ownerId, cloudinaryUpload(), {
            name: 'pic',
          }),
        ).rejects.toBe(readFailed);

        expect(deleteFile).not.toHaveBeenCalled();
        expect(cloudinary.delete).not.toHaveBeenCalled();
        expect(await countRows(client, workspaceId)).toBe(1);
        // Not even attempted: the scoping alone keeps a committed row's bytes
        // out of the cleanup (the share guard is only the second line).
        expect(isFileShared).not.toHaveBeenCalled();
      });
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
