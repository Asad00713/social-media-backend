import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  CloudinaryService,
  UploadResult,
} from '../../media/cloudinary.service';
import { StorageFullException } from '../lib/storage';
import { LibraryIngestService } from './library-ingest.service';
import type { MediaItemService } from './media-item.service';
import type { StorageQuotaService } from './storage-quota.service';

const WS = 'ws-1';
const USER = 'user-1';

const upload: UploadResult = {
  publicId: 'social-media/a',
  url: 'http://x/a.png',
  secureUrl: 'https://x/a.png',
  format: 'png',
  resourceType: 'image',
  bytes: 10,
};

function make() {
  const order: string[] = [];
  const cloudinary = {
    uploadFromBuffer: jest.fn<Promise<UploadResult>, unknown[]>(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
    uploadFromUrl: jest.fn<Promise<UploadResult>, unknown[]>(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
    uploadFromBase64: jest.fn<Promise<UploadResult>, unknown[]>(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
    delete: jest.fn().mockResolvedValue(true),
  };
  const quota = {
    assertCanStore: jest.fn(() => {
      order.push('quota');
      return Promise.resolve({ used: 0, limit: 100 });
    }),
  };
  const item = { id: 'item-1' };
  const mediaItems = {
    assertMediaFolder: jest.fn(() => {
      order.push('folder');
      return Promise.resolve();
    }),
    createFromUpload: jest.fn<Promise<unknown>, unknown[]>(() => {
      order.push('create');
      return Promise.resolve(item);
    }),
  };
  const service = new LibraryIngestService(
    cloudinary as unknown as CloudinaryService,
    quota as unknown as StorageQuotaService,
    mediaItems as unknown as MediaItemService,
  );
  return { service, cloudinary, quota, mediaItems, item, order };
}

const buffer = Buffer.from('hello');

describe('LibraryIngestService', () => {
  it('refuses before uploading when storage is full', async () => {
    const { service, quota, cloudinary, mediaItems } = make();
    quota.assertCanStore.mockRejectedValue(
      new StorageFullException({ used: 100, limit: 100 }),
    );
    await expect(
      service.ingestBuffer({ workspaceId: WS, userId: USER, buffer }),
    ).rejects.toBeInstanceOf(StorageFullException);
    expect(quota.assertCanStore).toHaveBeenCalledWith(WS, buffer.length);
    expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
    expect(mediaItems.createFromUpload).not.toHaveBeenCalled();
  });

  it('a thumbnail is stored but creates no Library item', async () => {
    const { service, mediaItems } = make();
    const res = await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer,
      purpose: 'thumbnail',
    });
    expect(res).toEqual({ upload, libraryItem: null });
    expect(mediaItems.createFromUpload).not.toHaveBeenCalled();
  });

  it('returns the created Library item, named after the file', async () => {
    const { service, mediaItems, item, order } = make();
    const res = await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer,
      originalName: 'summer.launch.png',
      mimeType: 'image/png',
    });
    expect(res).toEqual({ upload, libraryItem: item });
    expect(order).toEqual(['quota', 'upload', 'create']);
    expect(mediaItems.createFromUpload).toHaveBeenCalledWith(WS, USER, upload, {
      name: 'summer.launch',
      mimeType: 'image/png',
      categoryId: undefined,
      tags: undefined,
    });
  });

  it("names a file without a name 'Untitled'", async () => {
    const { service, mediaItems } = make();
    await service.ingestBuffer({ workspaceId: WS, userId: USER, buffer });
    expect(mediaItems.createFromUpload).toHaveBeenCalledWith(
      WS,
      USER,
      upload,
      expect.objectContaining({ name: 'Untitled' }),
    );
  });

  it('files the item into the folder with its tags; tags reach Cloudinary too', async () => {
    const { service, mediaItems, cloudinary, order } = make();
    await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer,
      categoryId: 'folder-1',
      tags: ['launch'],
    });
    expect(order[0]).toBe('folder');
    expect(mediaItems.assertMediaFolder).toHaveBeenCalledWith(WS, 'folder-1');
    expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(
      buffer,
      expect.objectContaining({ tags: ['launch'] }),
    );
    expect(mediaItems.createFromUpload).toHaveBeenCalledWith(
      WS,
      USER,
      upload,
      expect.objectContaining({ categoryId: 'folder-1', tags: ['launch'] }),
    );
  });

  it('a bad folder fails before any bytes are stored', async () => {
    const { service, mediaItems, cloudinary, quota } = make();
    mediaItems.assertMediaFolder.mockRejectedValue(
      new BadRequestException('Folder "Tpl" is not a media folder'),
    );
    await expect(
      service.ingestBuffer({
        workspaceId: WS,
        userId: USER,
        buffer,
        categoryId: 'tpl-folder',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(quota.assertCanStore).not.toHaveBeenCalled();
    expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('a 413 from saving the item propagates unchanged', async () => {
    const { service, mediaItems } = make();
    const full = new StorageFullException({ used: 99, limit: 100 });
    mediaItems.createFromUpload.mockRejectedValue(full);
    await expect(
      service.ingestBuffer({ workspaceId: WS, userId: USER, buffer }),
    ).rejects.toBe(full);
  });

  it('a remote URL checks one byte first and is named after its last segment', async () => {
    const { service, quota, cloudinary, mediaItems, order } = make();
    await service.ingestRemoteUrl({
      workspaceId: WS,
      userId: USER,
      url: 'https://images.test/path/team%20photo.jpg?w=200',
      tags: ['t'],
    });
    expect(order).toEqual(['quota', 'upload', 'create']);
    expect(quota.assertCanStore).toHaveBeenCalledWith(WS, 1);
    expect(cloudinary.uploadFromUrl).toHaveBeenCalledWith(
      'https://images.test/path/team%20photo.jpg?w=200',
      expect.objectContaining({ tags: ['t'] }),
    );
    expect(mediaItems.createFromUpload).toHaveBeenCalledWith(
      WS,
      USER,
      upload,
      expect.objectContaining({ name: 'team photo', tags: ['t'] }),
    );
  });

  it('base64 checks the decoded size first and reads the mime type', async () => {
    const { service, quota, mediaItems, order } = make();
    const data = 'data:image/png;base64,' + 'A'.repeat(400);
    await service.ingestBase64({ workspaceId: WS, userId: USER, data });
    expect(order).toEqual(['quota', 'upload', 'create']);
    expect(quota.assertCanStore).toHaveBeenCalledWith(
      WS,
      Math.floor((data.length * 3) / 4),
    );
    expect(mediaItems.createFromUpload).toHaveBeenCalledWith(
      WS,
      USER,
      upload,
      expect.objectContaining({ name: 'Untitled', mimeType: 'image/png' }),
    );
  });

  // Fix round 1 (Critical 1): with overwrite:false, Cloudinary hands back an
  // EXISTING asset for a public id that is taken. The server therefore picks
  // every location itself and never forwards a client folder or public id.
  describe('storage location', () => {
    const PID =
      /^library\/ws-1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const stray = { folder: 'social-media', publicId: 'library/other/victim' };

    it.each([
      [
        'buffer',
        (s: LibraryIngestService) =>
          s.ingestBuffer({
            workspaceId: WS,
            userId: USER,
            buffer,
            ...stray,
          } as never),
        'uploadFromBuffer',
      ],
      [
        'remote url',
        (s: LibraryIngestService) =>
          s.ingestRemoteUrl({
            workspaceId: WS,
            userId: USER,
            url: 'https://i.test/a.png',
            ...stray,
          } as never),
        'uploadFromUrl',
      ],
      [
        'base64',
        (s: LibraryIngestService) =>
          s.ingestBase64({
            workspaceId: WS,
            userId: USER,
            data: 'aGk=',
            ...stray,
          } as never),
        'uploadFromBase64',
      ],
    ] as const)(
      '%s: stored at library/<ws>/<uuid>, caller folder and public id ignored',
      async (_name, run, method) => {
        const { service, cloudinary } = make();
        await run(service);
        await run(service);
        const calls = cloudinary[method].mock.calls;
        const first = calls[0][1] as Record<string, unknown>;
        const second = calls[1][1] as Record<string, unknown>;
        expect(first.publicId).toMatch(PID);
        expect(first.folder).toBeUndefined();
        expect(second.publicId).toMatch(PID);
        expect(second.publicId).not.toBe(first.publicId);
      },
    );
  });

  // Fix round 2: orphan cleanup lives in createFromUpload, around the locked
  // insert only. Ingest never deletes: after a commit the bytes are a row's.
  describe('cleanup ownership (fix round 2)', () => {
    it.each([
      ['a generic failure', new Error('read failed after commit')],
      ['a 413', new StorageFullException({ used: 99, limit: 100 })],
      ['a conflict', new ConflictException({ code: 'UPLOAD_CONFLICT' })],
    ])(
      '%s from createFromUpload propagates; ingest deletes nothing',
      async (_n, err) => {
        const { service, mediaItems, cloudinary } = make();
        mediaItems.createFromUpload.mockRejectedValue(err);
        await expect(
          service.ingestBuffer({ workspaceId: WS, userId: USER, buffer }),
        ).rejects.toBe(err);
        expect(cloudinary.delete).not.toHaveBeenCalled();
      },
    );
  });

  // Fix round 2: a poster goes to library-thumbs/<ws>/, a prefix POST items
  // refuses, so it can never be registered as a Library item.
  it('a thumbnail is stored at library-thumbs/<ws>/<uuid>', async () => {
    const { service, cloudinary } = make();
    await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer,
      purpose: 'thumbnail',
    });
    const opts = cloudinary.uploadFromBuffer.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts.publicId).toMatch(
      /^library-thumbs\/ws-1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(opts.folder).toBeUndefined();
  });
});
