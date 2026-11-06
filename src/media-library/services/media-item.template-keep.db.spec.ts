import type { PoolClient } from 'pg';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { DbType } from '../../drizzle/db';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedTemplate,
} from '../testing/library-db';
import { StorageObjectService } from './storage-object.service';
import { RecycleBinService } from './recycle-bin.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function setup(db: DbType) {
  const cloudinary = {
    delete: jest.fn().mockResolvedValue(true),
    isOwnUrl: jest.fn().mockReturnValue(false),
  };
  const r2 = {
    deleteObject: jest.fn().mockResolvedValue(undefined),
    keyFromPublicUrl: jest.fn().mockReturnValue(null),
    isOwnUrl: jest.fn().mockReturnValue(false),
  };
  const storage = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    db,
  );
  const service = makeMediaItemService(db, { storageObjects: storage });
  const recycleBin = new RecycleBinService(db, service);
  return { cloudinary, storage, service, recycleBin };
}

async function rowExists(client: PoolClient, id: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM media_items WHERE id = $1', [id]);
  return r.rowCount === 1;
}

/** A template whose `content.media[]` carries `url`, or whose thumbnail is it. */
async function seedTemplateUsing(
  client: PoolClient,
  workspaceId: string,
  createdById: string,
  how: 'media' | 'thumbnail',
  url: string,
): Promise<string> {
  const id = await seedTemplate(client, {
    workspaceId,
    createdById,
    thumbnailUrl: how === 'thumbnail' ? url : null,
  });
  if (how === 'media') {
    await client.query(
      `UPDATE media_templates SET content = $2::jsonb WHERE id = $1`,
      [
        id,
        JSON.stringify({
          text: 'Hi',
          mediaSlots: [],
          hashtags: [],
          media: [{ id: 'att-1', type: 'image', url }],
        }),
      ],
    );
  }
  return id;
}

/** A binned media item with its own public id, binned `daysAgo` days ago. */
async function seedBinned(
  client: PoolClient,
  workspaceId: string,
  uploadedById: string,
  tag: string,
  daysAgo = 0,
): Promise<{ id: string; fileUrl: string; publicId: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileUrl = `https://cdn.example.test/${tag}-${stamp}.png`;
  const publicId = `social-media/${tag}-${stamp}`;
  const id = await seedMediaItem(client, {
    workspaceId,
    uploadedById,
    fileUrl,
    cloudinaryPublicId: publicId,
    isDeleted: true,
    deletedAt: new Date(Date.now() - daysAgo * DAY_MS),
  });
  return { id, fileUrl, publicId };
}

describeLibraryDb('template media keeps its bytes (I1)', () => {
  for (const how of ['media', 'thumbnail'] as const) {
    it(`delete-forever keeps a file a template uses as ${how}; deletes it without one`, async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const { service, cloudinary } = setup(db);
        const kept = await seedBinned(client, workspaceId, ownerId, 'kept');
        const gone = await seedBinned(client, workspaceId, ownerId, 'gone');
        await seedTemplateUsing(
          client,
          workspaceId,
          ownerId,
          how,
          kept.fileUrl,
        );

        await service.permanentDelete(workspaceId, kept.id);
        await service.permanentDelete(workspaceId, gone.id);

        // Both rows go; only the template-free file loses its bytes.
        expect(await rowExists(client, kept.id)).toBe(false);
        expect(await rowExists(client, gone.id)).toBe(false);
        expect(cloudinary.delete).toHaveBeenCalledTimes(1);
        expect(cloudinary.delete).toHaveBeenCalledWith(gone.publicId, 'image');
      });
    });
  }

  it('empty-bin keeps a file a template uses; deletes it without one', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { recycleBin, cloudinary } = setup(db);
      const kept = await seedBinned(client, workspaceId, ownerId, 'kept');
      const gone = await seedBinned(client, workspaceId, ownerId, 'gone');
      await seedTemplateUsing(
        client,
        workspaceId,
        ownerId,
        'media',
        kept.fileUrl,
      );

      const r = await recycleBin.empty(workspaceId);

      expect(r.deleted).toBeGreaterThanOrEqual(2);
      expect(await rowExists(client, kept.id)).toBe(false);
      expect(await rowExists(client, gone.id)).toBe(false);
      expect(cloudinary.delete).toHaveBeenCalledWith(gone.publicId, 'image');
      expect(cloudinary.delete).not.toHaveBeenCalledWith(
        kept.publicId,
        expect.anything(),
      );
    });
  });

  it('the retention purge keeps a file a template uses; deletes it without one', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service, cloudinary } = setup(db);
      const kept = await seedBinned(client, workspaceId, ownerId, 'kept', 40);
      const gone = await seedBinned(client, workspaceId, ownerId, 'gone', 40);
      await seedTemplateUsing(
        client,
        workspaceId,
        ownerId,
        'thumbnail',
        kept.fileUrl,
      );

      await service.cleanupRecycleBin(new Date());

      expect(await rowExists(client, kept.id)).toBe(false);
      expect(await rowExists(client, gone.id)).toBe(false);
      expect(cloudinary.delete).toHaveBeenCalledWith(gone.publicId, 'image');
      expect(cloudinary.delete).not.toHaveBeenCalledWith(
        kept.publicId,
        expect.anything(),
      );
    });
  });

  it("another workspace's template does not keep the file", async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { service, cloudinary } = setup(db);
      const item = await seedBinned(client, a.workspaceId, a.ownerId, 'x');
      await seedTemplateUsing(
        client,
        b.workspaceId,
        b.ownerId,
        'media',
        item.fileUrl,
      );

      await service.permanentDelete(a.workspaceId, item.id);

      expect(cloudinary.delete).toHaveBeenCalledWith(item.publicId, 'image');
    });
  });

  it('isFileReferenced (the discard guard) sees a template, scoped to the workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const { storage } = setup(db);
      const url = `https://cdn.example.test/poster-${Date.now()}.jpg`;
      await seedTemplateUsing(
        client,
        a.workspaceId,
        a.ownerId,
        'thumbnail',
        url,
      );

      expect(
        await storage.isFileReferenced({
          fileUrl: url,
          workspaceId: a.workspaceId,
        }),
      ).toBe(true);
      expect(
        await storage.isFileReferenced({
          fileUrl: url,
          workspaceId: b.workspaceId,
        }),
      ).toBe(false);
    });
  });

  it('a template does not make an item "used": neverUsed still lists it', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { service } = setup(db);
      const fileUrl = `https://cdn.example.test/tpl-only-${Date.now()}.png`;
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        fileUrl,
      });
      await seedTemplateUsing(client, workspaceId, ownerId, 'media', fileUrl);

      const page = await service.findAll(workspaceId, { neverUsed: true });

      expect(page.items.map((i) => i.id)).toContain(id);
    });
  });
});
