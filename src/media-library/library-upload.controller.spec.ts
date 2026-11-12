import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageFullException } from './lib/storage';
import { LibraryUploadController } from './library-upload.controller';
import { StorageQuotaService } from './services/storage-quota.service';
import { cloudinaryUploadFolder } from './services/storage-object.service';

const WS = '3f2b1c9e-0a4d-4c55-9a77-1d2e3f4a5b6c';
const user = { userId: 'u1', email: 'u@x.com' };
const upload = {
  publicId: 'social-media/a',
  url: 'http://x/a.png',
  secureUrl: 'https://x/a.png',
  format: 'png',
  resourceType: 'image',
  bytes: 10,
};
const libraryItem = { id: 'item-1' };
const file = {
  buffer: Buffer.from('img'),
  originalname: 'a.png',
  mimetype: 'image/png',
} as Express.Multer.File;

function noAccess() {
  return { assertCan: jest.fn().mockRejectedValue(new NotFoundException()) };
}
function okAccess() {
  return { assertCan: jest.fn().mockResolvedValue('MEMBER') };
}

/** A real quota service whose usage read is stubbed: its limit logic runs. */
function quotaUsing(used: number, limit = 1000) {
  const quota = new StorageQuotaService(undefined as never);
  jest.spyOn(quota, 'getUsage').mockResolvedValue({ used, limit });
  return quota;
}

function make(
  access: { assertCan: jest.Mock },
  quota: StorageQuotaService = quotaUsing(0),
) {
  const ingest = {
    ingestBuffer: jest.fn().mockResolvedValue({ upload, libraryItem }),
    ingestRemoteUrl: jest.fn().mockResolvedValue({ upload, libraryItem }),
    ingestBase64: jest.fn().mockResolvedValue({ upload, libraryItem }),
  };
  const cloudinaryService = {
    generateSignedUploadParams: jest.fn((publicId: string) => ({
      signature: 's',
      timestamp: 1,
      cloudName: 'acme',
      apiKey: 'k',
      publicId,
      overwrite: false as const,
    })),
  };
  const r2Service = {
    createPresignedUpload: jest.fn().mockResolvedValue({ ok: 1 }),
  };
  const c = Object.create(
    LibraryUploadController.prototype,
  ) as LibraryUploadController;
  Object.assign(c, { ingest, quota, cloudinaryService, r2Service, access });
  return { c, ingest, cloudinaryService, r2Service, access };
}

const calls: Array<[string, (c: LibraryUploadController) => Promise<unknown>]> =
  [
    [
      'uploadFromUrl',
      (c) =>
        c.uploadFromUrl({ workspaceId: WS, url: 'https://i.test/a.png' }, user),
    ],
    [
      'uploadFromBase64',
      (c) => c.uploadFromBase64({ workspaceId: WS, data: 'aGk=' }, user),
    ],
    ['uploadFile', (c) => c.uploadFile(file, { workspaceId: WS }, user)],
    [
      'getSignedUploadParams',
      (c) => c.getSignedUploadParams({ workspaceId: WS, bytes: 10 }, user),
    ],
    [
      'presignComposerVideo',
      (c) =>
        c.presignComposerVideo(
          { workspaceId: WS, contentType: 'video/mp4', sizeBytes: 10 },
          user,
        ),
    ],
    [
      'presignComposerDocument',
      (c) =>
        c.presignComposerDocument(
          { workspaceId: WS, contentType: 'application/pdf', sizeBytes: 10 },
          user,
        ),
    ],
  ];

describe('LibraryUploadController', () => {
  it.each(calls)('%s sits behind JwtAuthGuard', (method) => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      (LibraryUploadController.prototype as unknown as Record<string, object>)[
        method
      ],
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it.each(calls)(
    '%s: a non-member gets NotFound and nothing is stored or signed',
    async (_name, run) => {
      const { c, ingest, cloudinaryService, r2Service } = make(noAccess());
      await expect(run(c)).rejects.toBeInstanceOf(NotFoundException);
      expect(ingest.ingestBuffer).not.toHaveBeenCalled();
      expect(ingest.ingestRemoteUrl).not.toHaveBeenCalled();
      expect(ingest.ingestBase64).not.toHaveBeenCalled();
      expect(
        cloudinaryService.generateSignedUploadParams,
      ).not.toHaveBeenCalled();
      expect(r2Service.createPresignedUpload).not.toHaveBeenCalled();
    },
  );

  it.each(calls)('%s: a member needs posts:draft', async (_name, run) => {
    const { c, access } = make(okAccess());
    await expect(run(c)).resolves.toBeDefined();
    expect(access.assertCan).toHaveBeenCalledWith(WS, 'u1', 'posts:draft');
  });

  it('signed-upload-params over the limit is a 413 and signs nothing', async () => {
    const { c, cloudinaryService } = make(okAccess(), quotaUsing(900));
    await expect(
      c.getSignedUploadParams({ workspaceId: WS, bytes: 200 }, user),
    ).rejects.toBeInstanceOf(StorageFullException);
    expect(cloudinaryService.generateSignedUploadParams).not.toHaveBeenCalled();
  });

  it('signed-upload-params pins a fresh public id under the workspace, overwrite off', async () => {
    const { c, cloudinaryService } = make(okAccess());
    const res = await c.getSignedUploadParams(
      { workspaceId: WS, bytes: 10, folder: 'elsewhere' },
      user,
    );
    const again = await c.getSignedUploadParams(
      { workspaceId: WS, bytes: 10 },
      user,
    );
    const pid = new RegExp(
      `^${cloudinaryUploadFolder(WS)}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    );
    const signed =
      cloudinaryService.generateSignedUploadParams.mock.calls[0][0];
    expect(signed).toMatch(pid);
    expect(res).toMatchObject({
      publicId: signed,
      overwrite: false,
      uploadUrl: 'https://api.cloudinary.com/v1_1/acme/auto/upload',
    });
    expect(res).not.toHaveProperty('folder');
    expect(again.publicId).not.toBe(res.publicId);
  });

  it('presign over the limit is a 413 and presigns nothing', async () => {
    const { c, r2Service } = make(okAccess(), quotaUsing(900));
    await expect(
      c.presignComposerVideo(
        { workspaceId: WS, contentType: 'video/mp4', sizeBytes: 200 },
        user,
      ),
    ).rejects.toBeInstanceOf(StorageFullException);
    expect(r2Service.createPresignedUpload).not.toHaveBeenCalled();
  });

  it('document presign over the limit is a 413 and presigns nothing', async () => {
    const { c, r2Service } = make(okAccess(), quotaUsing(900));
    await expect(
      c.presignComposerDocument(
        { workspaceId: WS, contentType: 'application/pdf', sizeBytes: 200 },
        user,
      ),
    ).rejects.toBeInstanceOf(StorageFullException);
    expect(r2Service.createPresignedUpload).not.toHaveBeenCalled();
  });

  it('a document presign asks R2 for the composer-document kind', async () => {
    const { c, r2Service } = make(okAccess());
    await c.presignComposerDocument(
      {
        workspaceId: WS,
        contentType: 'application/pdf',
        sizeBytes: 10,
        filename: 'deck.pdf',
      },
      user,
    );
    expect(r2Service.createPresignedUpload).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: 'u1',
      kind: 'composer-document',
      contentType: 'application/pdf',
      sizeBytes: 10,
      filename: 'deck.pdf',
    });
  });

  it('upload/file returns the Library item; comma tags arrive split and trimmed', async () => {
    const { c, ingest } = make(okAccess());
    const res = await c.uploadFile(
      file,
      { workspaceId: WS, categoryId: 'folder-1', tags: 'a, b' },
      user,
    );
    expect(ingest.ingestBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: 'u1',
        buffer: file.buffer,
        originalName: 'a.png',
        mimeType: 'image/png',
        categoryId: 'folder-1',
        tags: ['a', 'b'],
        purpose: 'library',
      }),
    );
    expect(res).toEqual({
      message: 'Media uploaded successfully',
      originalName: 'a.png',
      mimeType: 'image/png',
      ...upload,
      libraryItem,
    });
  });

  it('a thumbnail upload ignores folder and tags', async () => {
    const { c, ingest } = make(okAccess());
    await c.uploadFile(
      file,
      {
        workspaceId: WS,
        categoryId: 'folder-1',
        tags: 'a',
        purpose: 'thumbnail',
      },
      user,
    );
    const arg = (ingest.ingestBuffer.mock.calls[0] as unknown[])[0];
    expect(arg).toMatchObject({ purpose: 'thumbnail', tags: [] });
    expect((arg as { categoryId?: string }).categoryId).toBeUndefined();
  });

  it('upload/url passes folder and tags and returns the Library item', async () => {
    const { c, ingest } = make(okAccess());
    const res = await c.uploadFromUrl(
      {
        workspaceId: WS,
        url: 'https://i.test/a.png',
        categoryId: 'folder-1',
        tags: ['x'],
      },
      user,
    );
    expect(ingest.ingestRemoteUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: 'u1',
        url: 'https://i.test/a.png',
        categoryId: 'folder-1',
        tags: ['x'],
      }),
    );
    expect(res).toEqual({
      message: 'Media uploaded successfully',
      ...upload,
      libraryItem,
    });
  });

  // Fix round 1 (Critical 1): a client folder or public id never reaches
  // storage; the server picks the location.
  it('upload/url, upload/base64 and upload/file never forward a client folder or public id', async () => {
    const { c, ingest } = make(okAccess());
    const stray = { folder: 'social-media', publicId: 'library/other/victim' };
    await c.uploadFromUrl(
      { workspaceId: WS, url: 'https://i.test/a.png', ...stray },
      user,
    );
    await c.uploadFromBase64({ workspaceId: WS, data: 'aGk=', ...stray }, user);
    await c.uploadFile(file, { workspaceId: WS, folder: 'social-media' }, user);
    const firstArg = (fn: jest.Mock) =>
      (fn.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    for (const arg of [
      firstArg(ingest.ingestRemoteUrl),
      firstArg(ingest.ingestBase64),
      firstArg(ingest.ingestBuffer),
    ]) {
      expect(arg).not.toHaveProperty('folder');
      expect(arg).not.toHaveProperty('publicId');
    }
  });
});
