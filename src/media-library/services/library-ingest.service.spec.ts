import { BadRequestException } from '@nestjs/common';
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
    uploadFromBuffer: jest.fn(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
    uploadFromUrl: jest.fn(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
    uploadFromBase64: jest.fn(() => {
      order.push('upload');
      return Promise.resolve(upload);
    }),
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
    createFromUpload: jest.fn(() => {
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
});
