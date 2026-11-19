import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type {
  CloudinaryService,
  UploadResult,
} from '../../media/cloudinary.service';
import { DocumentNeedsR2Exception, StorageFullException } from '../lib/storage';
import {
  LibraryIngestService,
  THUMBNAIL_MAX_BYTES,
} from './library-ingest.service';
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

/**
 * A real PNG header, because the ingest paths now sniff the bytes.
 *
 * `Buffer.from('hello')` was fine while the only byte check was a DENYLIST
 * ("are these bytes a PDF?") - placeholder bytes are not a PDF, so they
 * passed. The allowlist asks the opposite question, and placeholder bytes are
 * not a PNG either, so a fixture standing in for "a valid upload" now has to
 * actually be one.
 */
const buffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
]);

/**
 * A PNG of exactly `bytes` length: a real header, then padding.
 *
 * The size-cap tests are about SIZE, so their payload still has to pass the
 * byte sniffer - otherwise they would pass or fail for the wrong reason.
 */
function sizedPng(bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  buffer.copy(out, 0, 0, Math.min(buffer.length, bytes));
  return out;
}

/** The same real PNG, base64-encoded, for the data-URI paths. */
const pngBase64 = buffer.toString('base64');

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
    // Real PNG bytes padded out, not `'A'.repeat(400)`: that decodes to zeros,
    // which the byte sniffer refuses. The property under test is the SIZE
    // arithmetic and the declared mime type, so the payload has to be a file
    // that would really be stored.
    const data =
      'data:image/png;base64,' +
      sizedPng(300).toString('base64').padEnd(400, 'A').slice(0, 400);
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
            data: pngBase64,
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

  // M5: a poster is an image, and a small one.
  it("a thumbnail is uploaded as resourceType 'image', whatever the client sent", async () => {
    const { service, cloudinary } = make();
    await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer,
      resourceType: 'video',
      purpose: 'thumbnail',
    });
    const opts = cloudinary.uploadFromBuffer.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts.resourceType).toBe('image');
  });

  it('a thumbnail over the cap is refused with 413 before any check or upload', async () => {
    const { service, cloudinary, quota } = make();
    const big = Buffer.alloc(THUMBNAIL_MAX_BYTES + 1);
    await expect(
      service.ingestBuffer({
        workspaceId: WS,
        userId: USER,
        buffer: big,
        purpose: 'thumbnail',
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(quota.assertCanStore).not.toHaveBeenCalled();
    expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('a thumbnail at the cap is stored; the cap is 10 MB', async () => {
    expect(THUMBNAIL_MAX_BYTES).toBe(10 * 1024 * 1024);
    const { service, cloudinary } = make();
    await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer: sizedPng(THUMBNAIL_MAX_BYTES),
      purpose: 'thumbnail',
    });
    expect(cloudinary.uploadFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('the cap does not apply to a Library upload', async () => {
    const { service, cloudinary } = make();
    await service.ingestBuffer({
      workspaceId: WS,
      userId: USER,
      buffer: sizedPng(THUMBNAIL_MAX_BYTES + 1),
      resourceType: 'video',
    });
    const opts = cloudinary.uploadFromBuffer.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts.resourceType).toBe('video');
  });

  describe('documents are never stored on Cloudinary', () => {
    const pdfBytes = Buffer.from('%PDF-1.7 ...');
    const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    const docBytes = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00,
    ]);

    it.each([
      ['a PDF mime type', { mimeType: 'application/pdf', buffer }],
      [
        'a DOCX mime type',
        {
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer,
        },
      ],
      ['a .pptx name', { originalName: 'deck.PPTX', buffer }],
      ['a .doc name', { originalName: 'brief.doc', buffer }],
      [
        'PDF bytes under an image name',
        { originalName: 'a.png', buffer: pdfBytes },
      ],
      ['ZIP (DOCX/PPTX) bytes', { buffer: docxBytes }],
      ['OLE (DOC/PPT) bytes', { buffer: docBytes }],
      ['a raw resource type', { buffer, resourceType: 'raw' as const }],
    ])('upload/file refuses %s before uploading', async (_label, input) => {
      const { service, cloudinary, quota, mediaItems } = make();
      await expect(
        service.ingestBuffer({ workspaceId: WS, userId: USER, ...input }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
      expect(quota.assertCanStore).not.toHaveBeenCalled();
      expect(mediaItems.createFromUpload).not.toHaveBeenCalled();
    });

    it('the 400 names the R2 route', async () => {
      const { service } = make();
      const err = await service
        .ingestBuffer({
          workspaceId: WS,
          userId: USER,
          buffer: pdfBytes,
          originalName: 'a.pdf',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DocumentNeedsR2Exception);
      const ex = err as DocumentNeedsR2Exception;
      expect(ex.getStatus()).toBe(400);
      expect(ex.getResponse()).toMatchObject({
        code: 'DOCUMENT_NEEDS_R2',
        route: 'POST /media/r2/presign-composer-document',
      });
    });

    it('a picture still goes to Cloudinary', async () => {
      const { service, cloudinary } = make();
      await service.ingestBuffer({
        workspaceId: WS,
        userId: USER,
        buffer,
        originalName: 'a.png',
        mimeType: 'image/png',
      });
      expect(cloudinary.uploadFromBuffer).toHaveBeenCalledTimes(1);
    });

    it('a thumbnail with PDF bytes is refused too', async () => {
      const { service, cloudinary } = make();
      await expect(
        service.ingestBuffer({
          workspaceId: WS,
          userId: USER,
          buffer: pdfBytes,
          purpose: 'thumbnail',
        }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
    });

    it('upload/url refuses a URL ending in a document extension', async () => {
      const { service, cloudinary } = make();
      await expect(
        service.ingestRemoteUrl({
          workspaceId: WS,
          userId: USER,
          url: 'https://example.com/files/Report.pdf?dl=1',
        }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      expect(cloudinary.uploadFromUrl).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a PDF stored as an image',
        { format: 'pdf', resourceType: 'image' as const },
      ],
      ['a raw file', { format: '', resourceType: 'raw' as const }],
    ])(
      'upload/url deletes %s Cloudinary fetched, and refuses it',
      async (_label, stored) => {
        const { service, cloudinary, mediaItems } = make();
        cloudinary.uploadFromUrl.mockResolvedValue({
          ...upload,
          publicId: 'library/ws-1/u1',
          ...stored,
        });
        await expect(
          service.ingestRemoteUrl({
            workspaceId: WS,
            userId: USER,
            url: 'https://example.com/download?id=7',
          }),
        ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
        expect(cloudinary.delete).toHaveBeenCalledWith(
          'library/ws-1/u1',
          stored.resourceType,
        );
        expect(mediaItems.createFromUpload).not.toHaveBeenCalled();
      },
    );

    it('an existing asset Cloudinary returned is refused but not deleted', async () => {
      const { service, cloudinary } = make();
      cloudinary.uploadFromUrl.mockResolvedValue({
        ...upload,
        format: 'pdf',
        existing: true,
      });
      await expect(
        service.ingestRemoteUrl({
          workspaceId: WS,
          userId: USER,
          url: 'https://example.com/x',
        }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('a failed delete still refuses', async () => {
      const { service, cloudinary } = make();
      cloudinary.uploadFromBuffer.mockResolvedValue({
        ...upload,
        format: 'pdf',
      });
      cloudinary.delete.mockRejectedValue(new Error('down'));
      await expect(
        service.ingestBuffer({ workspaceId: WS, userId: USER, buffer }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
    });

    it('upload/base64 refuses a PDF data URI and bare PDF base64', async () => {
      const { service, cloudinary } = make();
      await expect(
        service.ingestBase64({
          workspaceId: WS,
          userId: USER,
          data: 'data:application/pdf;base64,AAAA',
        }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      await expect(
        service.ingestBase64({
          workspaceId: WS,
          userId: USER,
          data: pdfBytes.toString('base64'),
        }),
      ).rejects.toBeInstanceOf(DocumentNeedsR2Exception);
      expect(cloudinary.uploadFromBase64).not.toHaveBeenCalled();
    });
  });
  /**
   * The allowlist, at the three doors it guards.
   *
   * `media-allowlist.spec.ts` tests the RULES; these test that each ingest
   * path applies them. Both are needed, and the gap was real: removing the
   * guard from any one of the three paths left this suite 37/37 green until
   * these tests existed - the same shape as the hand-list spec that passed
   * 14/14 while two publishing engines leaked.
   */
  describe('only allowed media is stored', () => {
    /** A Linux binary, renamed and mislabelled as a picture. */
    const elf = Buffer.concat([
      Buffer.from([0x7f]),
      Buffer.from('ELF'),
      Buffer.alloc(28),
    ]);
    /** An SVG, which has no magic number at all. */
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    it('upload/file refuses an executable renamed as a picture', async () => {
      const { service, cloudinary, quota } = make();
      await expect(
        service.ingestBuffer({
          workspaceId: WS,
          userId: USER,
          buffer: elf,
          originalName: 'cat.png',
          mimeType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      // Before any bytes are stored and before the quota is touched.
      expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
      expect(quota.assertCanStore).not.toHaveBeenCalled();
    });

    it('upload/file refuses an SVG, which no magic number can match', async () => {
      const { service, cloudinary } = make();
      await expect(
        service.ingestBuffer({
          workspaceId: WS,
          userId: USER,
          buffer: svg,
          originalName: 'logo.svg',
          mimeType: 'image/svg+xml',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(cloudinary.uploadFromBuffer).not.toHaveBeenCalled();
    });

    it('upload/base64 refuses an executable data URI', async () => {
      const { service, cloudinary } = make();
      await expect(
        service.ingestBase64({
          workspaceId: WS,
          userId: USER,
          data: `data:image/png;base64,${elf.toString('base64')}`,
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(cloudinary.uploadFromBase64).not.toHaveBeenCalled();
    });

    it('upload/base64 accepts a video, whose brand sits at offset 8', async () => {
      // The head handed to the sniffer has to reach offset 12: an MP4 is
      // identified by `ftyp` at 4 and its brand at 8. `base64Head` is derived
      // from SNIFF_BYTES so that stays true; the 16 characters it carried
      // before decoded to exactly 12 bytes, which worked with nothing spare.
      const mp4 = Buffer.alloc(64);
      mp4.writeUInt32BE(64, 0);
      mp4.write('ftyp', 4, 'latin1');
      mp4.write('isom', 8, 'latin1');
      const { service, cloudinary } = make();
      await service.ingestBase64({
        workspaceId: WS,
        userId: USER,
        data: mp4.toString('base64'),
        resourceType: 'video',
      });
      expect(cloudinary.uploadFromBase64).toHaveBeenCalledTimes(1);
    });

    it('upload/url deletes and refuses a non-media file Cloudinary fetched', async () => {
      // The bytes were never here to sniff, so the check runs afterwards on
      // Cloudinary's own verdict - and the stored copy is deleted first, so
      // nothing we refused is left behind.
      const { service, cloudinary } = make();
      cloudinary.uploadFromUrl.mockResolvedValue({
        ...upload,
        format: 'svg',
        resourceType: 'image',
      });
      await expect(
        service.ingestRemoteUrl({
          workspaceId: WS,
          userId: USER,
          url: 'https://example.com/logo',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(cloudinary.delete).toHaveBeenCalledWith(upload.publicId, 'image');
    });

    it('upload/url leaves an existing asset alone while still refusing', async () => {
      // An `existing` asset is someone else's; refusing ours must not delete
      // theirs. Same rule as the document path.
      const { service, cloudinary } = make();
      cloudinary.uploadFromUrl.mockResolvedValue({
        ...upload,
        format: 'svg',
        resourceType: 'image',
        existing: true,
      });
      await expect(
        service.ingestRemoteUrl({
          workspaceId: WS,
          userId: USER,
          url: 'https://example.com/logo',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('a real picture still goes through every path', async () => {
      const { service, cloudinary } = make();
      await service.ingestBuffer({
        workspaceId: WS,
        userId: USER,
        buffer,
        originalName: 'a.png',
        mimeType: 'image/png',
      });
      await service.ingestBase64({
        workspaceId: WS,
        userId: USER,
        data: pngBase64,
      });
      expect(cloudinary.uploadFromBuffer).toHaveBeenCalledTimes(1);
      expect(cloudinary.uploadFromBase64).toHaveBeenCalledTimes(1);
    });
  });
});
