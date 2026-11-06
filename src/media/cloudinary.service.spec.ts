import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { CloudinaryService } from './cloudinary.service';

const SECRET = 'test-secret';

function service(configured = true) {
  const values: Record<string, string> = configured
    ? {
        CLOUDINARY_CLOUD_NAME: 'acme',
        CLOUDINARY_API_KEY: 'key',
        CLOUDINARY_API_SECRET: SECRET,
      }
    : {};
  const config = {
    get: (k: string) => values[k],
  } as unknown as ConfigService;
  return new CloudinaryService(config);
}

function apiResponse(over: Partial<UploadApiResponse> = {}): UploadApiResponse {
  return {
    public_id: 'library/ws/abc',
    url: 'http://res.cloudinary.com/acme/image/upload/v1/library/ws/abc.png',
    secure_url:
      'https://res.cloudinary.com/acme/image/upload/v1/library/ws/abc.png',
    format: 'png',
    resource_type: 'image',
    bytes: 10,
    ...over,
  } as UploadApiResponse;
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CloudinaryService', () => {
  describe('generateSignedUploadParams', () => {
    it('signs an explicit public id with overwrite off, and returns both', () => {
      const params = service().generateSignedUploadParams('library/ws/abc');
      expect(params).toMatchObject({
        publicId: 'library/ws/abc',
        overwrite: false,
        cloudName: 'acme',
        apiKey: 'key',
      });
      // The client sends these unchanged; the signature must cover them all.
      expect(params.signature).toBe(
        cloudinary.utils.api_sign_request(
          {
            timestamp: params.timestamp,
            public_id: 'library/ws/abc',
            overwrite: false,
          },
          SECRET,
        ),
      );
      // A folder the signature does not cover would fail the upload.
      expect(params).not.toHaveProperty('folder');
    });
  });

  describe('getResourceBytes', () => {
    it('returns the stored size', async () => {
      const resource = jest
        .spyOn(cloudinary.api, 'resource')
        .mockResolvedValue({ bytes: 1234 } as never);
      await expect(
        service().getResourceBytes('library/ws/abc', 'video'),
      ).resolves.toEqual({ kind: 'size', bytes: 1234 });
      expect(resource).toHaveBeenCalledWith('library/ws/abc', {
        resource_type: 'video',
      });
    });

    it('is missing on a 404', async () => {
      jest
        .spyOn(cloudinary.api, 'resource')
        .mockRejectedValue({ error: { message: 'Not found', http_code: 404 } });
      await expect(
        service().getResourceBytes('library/ws/none', 'image'),
      ).resolves.toEqual({ kind: 'missing' });
    });

    it('is an error on any other failure, or without a size', async () => {
      const resource = jest.spyOn(cloudinary.api, 'resource');
      resource.mockRejectedValueOnce({
        error: { message: 'Rate limited', http_code: 420 },
      });
      await expect(
        service().getResourceBytes('library/ws/a', 'image'),
      ).resolves.toEqual({ kind: 'error' });
      resource.mockRejectedValueOnce(new Error('socket hang up'));
      await expect(
        service().getResourceBytes('library/ws/a', 'image'),
      ).resolves.toEqual({ kind: 'error' });
      resource.mockResolvedValueOnce({} as never);
      await expect(
        service().getResourceBytes('library/ws/a', 'image'),
      ).resolves.toEqual({ kind: 'error' });
    });

    it('is an error when Cloudinary is not configured', async () => {
      await expect(
        service(false).getResourceBytes('library/ws/a', 'image'),
      ).resolves.toEqual({ kind: 'error' });
    });
  });

  describe('uploads', () => {
    it("reports Cloudinary's existing flag", async () => {
      jest
        .spyOn(cloudinary.uploader, 'upload')
        .mockResolvedValue(apiResponse({ existing: true }));
      const res = await service().uploadFromUrl('https://i.test/a.png', {
        publicId: 'library/ws/abc',
      });
      expect(res.existing).toBe(true);
    });

    it('a fresh upload is not existing', async () => {
      jest
        .spyOn(cloudinary.uploader, 'upload')
        .mockResolvedValue(apiResponse());
      const res = await service().uploadFromUrl('https://i.test/a.png', {
        publicId: 'library/ws/abc',
      });
      expect(res.existing).toBe(false);
    });

    it('an explicit public id gets no default folder in front of it', async () => {
      const upload = jest
        .spyOn(cloudinary.uploader, 'upload')
        .mockResolvedValue(apiResponse());
      await service().uploadFromBase64('aGk=', { publicId: 'library/ws/abc' });
      const opts = upload.mock.calls[0][1] as unknown as Record<
        string,
        unknown
      >;
      expect(opts.public_id).toBe('library/ws/abc');
      expect(opts).not.toHaveProperty('folder');
      expect(opts.overwrite).toBe(false);
    });

    it('without a public id the default folder still applies', async () => {
      const upload = jest
        .spyOn(cloudinary.uploader, 'upload')
        .mockResolvedValue(apiResponse());
      await service().uploadFromUrl('https://i.test/a.png');
      const opts = upload.mock.calls[0][1] as unknown as Record<
        string,
        unknown
      >;
      expect(opts.folder).toBe('social-media');
    });
  });
});
