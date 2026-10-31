import type { ConfigService } from '@nestjs/config';
import { CloudinaryService } from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { BadRequestException } from '@nestjs/common';
import {
  StorageObjectService,
  cloudinaryResourceType,
  cloudinaryUploadFolder,
  type StoredFileRef,
} from './storage-object.service';

const R2_BASE = 'https://pub.r2.dev';
const WS = '3f2b1c9e-0a4d-4c55-9a77-1d2e3f4a5b6c';
const OTHER_WS = '9b8a7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const FILE = `1700000000000-${'a'.repeat(24)}.mp4`;
const keyFor = (ws: string) => `composer/videos/${ws}/user-1/${FILE}`;
const R2_KEY = keyFor(WS);

function makeMocks() {
  const cloudinary = {
    delete: jest.fn().mockResolvedValue(true),
    isOwnUrl: jest.fn().mockReturnValue(false),
    getResourceBytes: jest.fn().mockResolvedValue(null),
  };
  const r2 = {
    deleteObject: jest.fn().mockResolvedValue(undefined),
    verifyObject: jest.fn().mockResolvedValue({ exists: false }),
    keyFromPublicUrl: jest.fn((url: string) =>
      url.startsWith(`${R2_BASE}/`) ? url.slice(R2_BASE.length + 1) : null,
    ),
    isOwnUrl: jest.fn().mockReturnValue(false),
  };
  const service = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    undefined as never,
  );
  return { cloudinary, r2, service };
}

function ref(over: Partial<StoredFileRef> = {}): StoredFileRef {
  return {
    workspaceId: WS,
    cloudinaryPublicId: 'social-media/abc',
    fileUrl: 'https://res.cloudinary.com/acme/image/upload/abc.png',
    type: 'image',
    mimeType: 'image/png',
    ...over,
  };
}

describe('StorageObjectService', () => {
  describe('providerOf', () => {
    it('is r2 for an R2 url and cloudinary otherwise', () => {
      const { service } = makeMocks();
      expect(service.providerOf(`${R2_BASE}/${R2_KEY}`, null)).toBe('r2');
      expect(service.providerOf('https://x.test/a.png', 'id')).toBe(
        'cloudinary',
      );
    });
  });

  describe('deleteFile', () => {
    it('deletes an R2 file by key and never touches Cloudinary', async () => {
      const { service, r2, cloudinary } = makeMocks();
      await service.deleteFile(
        ref({
          fileUrl: `${R2_BASE}/${R2_KEY}`,
          cloudinaryPublicId: null,
          type: 'video',
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(R2_KEY);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('deletes a Cloudinary video with the video resource type', async () => {
      const { service, cloudinary } = makeMocks();
      await service.deleteFile(ref({ type: 'video', mimeType: 'video/mp4' }));
      expect(cloudinary.delete).toHaveBeenCalledWith(
        'social-media/abc',
        'video',
      );
    });

    it('uses image for a PDF document and raw for a docx', async () => {
      const { service, cloudinary } = makeMocks();
      await service.deleteFile(
        ref({ type: 'document', mimeType: 'application/pdf' }),
      );
      await service.deleteFile(
        ref({
          type: 'document',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileUrl: 'https://res.cloudinary.com/acme/raw/upload/a.docx',
        }),
      );
      expect(cloudinary.delete).toHaveBeenNthCalledWith(
        1,
        'social-media/abc',
        'image',
      );
      expect(cloudinary.delete).toHaveBeenNthCalledWith(
        2,
        'social-media/abc',
        'raw',
      );
    });

    it('treats a not-found (false) Cloudinary result as success', async () => {
      const { service, cloudinary } = makeMocks();
      cloudinary.delete.mockResolvedValue(false);
      await expect(service.deleteFile(ref())).resolves.toBeUndefined();
    });

    it('rejects when Cloudinary throws', async () => {
      const { service, cloudinary } = makeMocks();
      cloudinary.delete.mockRejectedValue(new Error('boom'));
      await expect(service.deleteFile(ref())).rejects.toThrow('boom');
    });

    it('never deletes an R2 object under another workspace prefix', async () => {
      const { service, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          fileUrl: `${R2_BASE}/${keyFor(OTHER_WS)}`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it.each([
      [
        'dot-dot traversal',
        `composer/videos/${WS}/../${OTHER_WS}/user-1/${FILE}`,
      ],
      [
        'encoded separator',
        `composer/videos/${WS}%2F..%2F${OTHER_WS}/user-1/${FILE}`,
      ],
      ['trailing query', `${R2_KEY}?x`],
      ['fragment', `${R2_KEY}#x`],
      ['backslash', `composer/videos/${WS}/user-1\\${FILE}`],
      ['empty segment', `composer/videos/${WS}//${FILE}`],
      ['unknown prefix', `other/videos/${WS}/user-1/${FILE}`],
    ])('refuses a key with %s', async (_label, key) => {
      const { service, r2 } = makeMocks();
      await service.deleteFile(
        ref({ fileUrl: `${R2_BASE}/${key}`, cloudinaryPublicId: null }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('refuses an R2 delete when the ref names no workspace', async () => {
      const { service, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          workspaceId: undefined,
          fileUrl: `${R2_BASE}/${R2_KEY}`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes an R2 object under the same workspace prefix', async () => {
      const { service, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          fileUrl: `${R2_BASE}/${keyFor(WS)}`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(keyFor(WS));
    });

    it('rejects when R2 throws', async () => {
      const { service, r2 } = makeMocks();
      r2.deleteObject.mockRejectedValue(new Error('r2 down'));
      await expect(
        service.deleteFile(
          ref({ fileUrl: `${R2_BASE}/${R2_KEY}`, cloudinaryPublicId: null }),
        ),
      ).rejects.toThrow('r2 down');
    });

    it('resolves without a call when there is no public id and it is not R2', async () => {
      const { service, cloudinary, r2 } = makeMocks();
      await expect(
        service.deleteFile(ref({ cloudinaryPublicId: null })),
      ).resolves.toBeUndefined();
      expect(cloudinary.delete).not.toHaveBeenCalled();
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('treats an R2 url as R2 even when the column says cloudinary', async () => {
      const { service, cloudinary, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          storageProvider: 'cloudinary',
          fileUrl: `${R2_BASE}/${R2_KEY}`,
          cloudinaryPublicId: null,
          type: 'video',
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(R2_KEY);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('keeps the workspace gate on that fallback', async () => {
      const { service, cloudinary, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          storageProvider: 'cloudinary',
          fileUrl: `${R2_BASE}/${keyFor(OTHER_WS)}`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('uses the stored provider when the url is not R2', async () => {
      const { service, cloudinary, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          storageProvider: 'r2',
          fileUrl: 'https://cdn.example.test/clip.mp4',
          cloudinaryPublicId: R2_KEY,
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(R2_KEY);
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });
  });

  describe('cloudinaryResourceType', () => {
    it('maps by type, mime and extension', () => {
      expect(cloudinaryResourceType(ref({ type: 'video' }))).toBe('video');
      expect(cloudinaryResourceType(ref({ type: 'gif' }))).toBe('image');
      expect(
        cloudinaryResourceType(
          ref({ type: 'document', mimeType: null, fileUrl: 'https://x/a.pdf' }),
        ),
      ).toBe('image');
      expect(
        cloudinaryResourceType(
          ref({ type: 'document', mimeType: null, fileUrl: 'https://x/a.zip' }),
        ),
      ).toBe('raw');
    });
  });

  describe('isOwnStorageUrl (real isOwnUrl implementations)', () => {
    function realService(values: Record<string, string>) {
      const config = {
        get: (key: string, fallback?: string) => values[key] ?? fallback,
      } as unknown as ConfigService;
      return new StorageObjectService(
        new CloudinaryService(config),
        new CloudflareR2Service(config),
        undefined as never,
      );
    }
    const full = {
      CLOUDINARY_CLOUD_NAME: 'acme',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
      CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'k',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 's',
      CLOUDFLARE_R2_BUCKET: 'bucket',
      CLOUDFLARE_R2_PUBLIC_URL: R2_BASE,
    };

    it('accepts our Cloudinary and R2 urls and rejects look-alikes', () => {
      const s = realService(full);
      expect(
        s.isOwnStorageUrl('https://res.cloudinary.com/acme/image/upload/x.png'),
      ).toBe(true);
      expect(
        s.isOwnStorageUrl(
          'https://res.cloudinary.com/other/image/upload/x.png',
        ),
      ).toBe(false);
      expect(
        s.isOwnStorageUrl('https://res.cloudinary.com.evil.io/acme/x.png'),
      ).toBe(false);
      expect(s.isOwnStorageUrl(`${R2_BASE}/composer/videos/a.mp4`)).toBe(true);
      expect(s.isOwnStorageUrl('https://pub.r2.dev.evil/a.mp4')).toBe(false);
    });

    it('rejects every R2 url when the R2 public base is unset', () => {
      const s = realService({ CLOUDINARY_CLOUD_NAME: 'acme' });
      expect(s.isOwnStorageUrl(`${R2_BASE}/composer/videos/a.mp4`)).toBe(false);
    });
  });

  describe('realSize', () => {
    it('asks R2 for an R2 file and returns its content length', async () => {
      const { service, r2, cloudinary } = makeMocks();
      r2.verifyObject.mockResolvedValue({ exists: true, contentLength: 4321 });
      await expect(
        service.realSize(
          ref({ fileUrl: `${R2_BASE}/${R2_KEY}`, cloudinaryPublicId: null }),
        ),
      ).resolves.toBe(4321);
      expect(r2.verifyObject).toHaveBeenCalledWith(R2_KEY);
      expect(cloudinary.getResourceBytes).not.toHaveBeenCalled();
    });

    it('is null for an R2 object that is not there', async () => {
      const { service } = makeMocks();
      await expect(
        service.realSize(
          ref({ fileUrl: `${R2_BASE}/${R2_KEY}`, cloudinaryPublicId: null }),
        ),
      ).resolves.toBeNull();
    });

    it('turns an R2 error into null instead of throwing', async () => {
      const { service, r2 } = makeMocks();
      r2.verifyObject.mockRejectedValue(new Error('R2 down'));
      jest
        .spyOn(
          (service as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      await expect(
        service.realSize(
          ref({ fileUrl: `${R2_BASE}/${R2_KEY}`, cloudinaryPublicId: null }),
        ),
      ).resolves.toBeNull();
    });

    it('asks Cloudinary by public id and resource type', async () => {
      const { service, cloudinary } = makeMocks();
      cloudinary.getResourceBytes.mockResolvedValue(777);
      await expect(
        service.realSize(ref({ type: 'video', mimeType: 'video/mp4' })),
      ).resolves.toBe(777);
      expect(cloudinary.getResourceBytes).toHaveBeenCalledWith(
        'social-media/abc',
        'video',
      );
    });

    it('is null for a non-R2 file without a public id', async () => {
      const { service, cloudinary } = makeMocks();
      await expect(
        service.realSize(ref({ cloudinaryPublicId: null })),
      ).resolves.toBeNull();
      expect(cloudinary.getResourceBytes).not.toHaveBeenCalled();
    });
  });

  // SEC5: `POST items` registers a file the client says it uploaded. Only an
  // object this workspace stored may be registered, or a row could be pointed
  // at another tenant's file (and later delete it, or count it as ours).
  describe('assertWorkspaceObject', () => {
    const CLOUD = 'https://res.cloudinary.com/acme';
    const pid = (ws: string) => `${cloudinaryUploadFolder(ws)}/abc123`;
    function withOwnCloud() {
      const mocks = makeMocks();
      mocks.cloudinary.isOwnUrl.mockImplementation((u: string) =>
        u.startsWith(`${CLOUD}/`),
      );
      return mocks;
    }
    const accept = (service: StorageObjectService, r: Partial<StoredFileRef>) =>
      expect(() =>
        service.assertWorkspaceObject(
          { fileUrl: '', cloudinaryPublicId: null, ...r },
          WS,
        ),
      ).not.toThrow();
    const reject = (service: StorageObjectService, r: Partial<StoredFileRef>) =>
      expect(() =>
        service.assertWorkspaceObject(
          { fileUrl: '', cloudinaryPublicId: null, ...r },
          WS,
        ),
      ).toThrow(BadRequestException);

    it('accepts this workspace R2 key, with or without the key as public id', () => {
      const { service } = withOwnCloud();
      accept(service, { fileUrl: `${R2_BASE}/${R2_KEY}` });
      accept(service, {
        fileUrl: `${R2_BASE}/${R2_KEY}`,
        cloudinaryPublicId: R2_KEY,
      });
    });

    it("rejects another workspace's R2 key and a mismatched public id", () => {
      const { service } = withOwnCloud();
      reject(service, { fileUrl: `${R2_BASE}/${keyFor(OTHER_WS)}` });
      reject(service, {
        fileUrl: `${R2_BASE}/${R2_KEY}`,
        cloudinaryPublicId: keyFor(OTHER_WS),
      });
      reject(service, { fileUrl: `${R2_BASE}/inbox/files/${WS}/a.pdf` });
    });

    it('accepts our Cloudinary file under this workspace folder', () => {
      const { service } = withOwnCloud();
      accept(service, {
        fileUrl: `${CLOUD}/image/upload/v1700000000/${pid(WS)}.png`,
        cloudinaryPublicId: pid(WS),
      });
      // Raw files keep the extension in the public id; no version segment.
      accept(service, {
        fileUrl: `${CLOUD}/raw/upload/${pid(WS)}.zip`,
        cloudinaryPublicId: `${pid(WS)}.zip`,
      });
    });

    it('rejects Cloudinary refs outside this workspace or not matching the url', () => {
      const { service } = withOwnCloud();
      // Another workspace's folder.
      reject(service, {
        fileUrl: `${CLOUD}/image/upload/v1/${pid(OTHER_WS)}.png`,
        cloudinaryPublicId: pid(OTHER_WS),
      });
      // A shared folder carries no workspace.
      reject(service, {
        fileUrl: `${CLOUD}/image/upload/v1/social-media/abc.png`,
        cloudinaryPublicId: 'social-media/abc',
      });
      // Our public id, but the url shows a different file.
      reject(service, {
        fileUrl: `${CLOUD}/image/upload/v1/social-media/abc.png`,
        cloudinaryPublicId: pid(WS),
      });
      // Traversal out of the folder.
      reject(service, {
        fileUrl: `${CLOUD}/image/upload/v1/${cloudinaryUploadFolder(WS)}/../x.png`,
        cloudinaryPublicId: `${cloudinaryUploadFolder(WS)}/../x`,
      });
      // No public id at all.
      reject(service, {
        fileUrl: `${CLOUD}/image/upload/v1/${pid(WS)}.png`,
      });
    });

    it('rejects a foreign url or another Cloudinary cloud', () => {
      const { service } = withOwnCloud();
      reject(service, {
        fileUrl: `https://evil.test/${pid(WS)}.png`,
        cloudinaryPublicId: pid(WS),
      });
      reject(service, {
        fileUrl: `https://res.cloudinary.com/other/image/upload/v1/${pid(WS)}.png`,
        cloudinaryPublicId: pid(WS),
      });
    });
  });
});
