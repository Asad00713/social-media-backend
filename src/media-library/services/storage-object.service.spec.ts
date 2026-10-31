import type { ConfigService } from '@nestjs/config';
import { CloudinaryService } from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import {
  StorageObjectService,
  cloudinaryResourceType,
  type StoredFileRef,
} from './storage-object.service';

const R2_BASE = 'https://pub.r2.dev';
const R2_KEY = 'composer/videos/w/u/1-a.mp4';

function makeMocks() {
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
  const service = new StorageObjectService(
    cloudinary as unknown as CloudinaryService,
    r2 as unknown as CloudflareR2Service,
    undefined as never,
  );
  return { cloudinary, r2, service };
}

function ref(over: Partial<StoredFileRef> = {}): StoredFileRef {
  return {
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
          workspaceId: 'ws-a',
          fileUrl: `${R2_BASE}/composer/videos/ws-b/u/1-a.mp4`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes an R2 object under the same workspace prefix', async () => {
      const { service, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          workspaceId: 'ws-a',
          fileUrl: `${R2_BASE}/composer/videos/ws-a/u/1-a.mp4`,
          cloudinaryPublicId: null,
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(
        'composer/videos/ws-a/u/1-a.mp4',
      );
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

    it('lets a stored provider win over the url', async () => {
      const { service, cloudinary, r2 } = makeMocks();
      await service.deleteFile(
        ref({
          storageProvider: 'cloudinary',
          fileUrl: `${R2_BASE}/${R2_KEY}`,
        }),
      );
      expect(cloudinary.delete).toHaveBeenCalledTimes(1);
      expect(r2.deleteObject).not.toHaveBeenCalled();
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
});
