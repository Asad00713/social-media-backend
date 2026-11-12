import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  CloudflareR2Service,
  PRESIGN_MAX_SECONDS,
  PRESIGN_MIN_SECONDS,
  presignExpirySeconds,
  safeKeyExtension,
} from './cloudflare-r2.service';

// Fix round 2: the presigned key is built from the client's filename, so its
// extension must never carry a path character into the key.
describe('safeKeyExtension', () => {
  it.each([
    ['clip.MP4', 'video/mp4', '.mp4'],
    ['a.b.webm', 'video/webm', '.webm'],
    ['voice.m4a', 'audio/mp4', '.m4a'],
  ])('keeps a plain extension: %s → %s', (filename, type, expected) => {
    expect(safeKeyExtension(type, filename)).toBe(expected);
  });

  it.each([
    ['x.mp4/../../etc', 'video/mp4', '.mp4'],
    ['x./..', 'video/quicktime', '.mov'],
    ['x.mp4%2F..', 'video/webm', '.webm'],
    ['x.verylongext', 'video/mp4', '.mp4'],
    ['x.mp-4', 'image/png', '.png'],
    ['x.mp4?a=b', 'audio/ogg', '.ogg'],
    ['x.éxe', 'image/gif', '.gif'],
  ])(
    'drops an unsafe extension and maps the mime type: %s',
    (filename, type, expected) => {
      expect(safeKeyExtension(type, filename)).toBe(expected);
    },
  );

  it.each([
    ['application/pdf', '.pdf'],
    ['application/msword', '.doc'],
    ['application/vnd.ms-powerpoint', '.ppt'],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.pptx',
    ],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.docx',
    ],
  ])('maps a document type with no usable name: %s', (type, expected) => {
    expect(safeKeyExtension(type, 'x.a/b')).toBe(expected);
  });

  it('is empty when neither the name nor the mime type gives a safe one', () => {
    expect(safeKeyExtension('application/x-unknown', 'x.a/b')).toBe('');
    expect(safeKeyExtension('application/x-unknown')).toBe('');
  });

  it('every result is a dot plus 1–8 lowercase alphanumerics, or empty', () => {
    const samples = ['..', '.', 'a.', '.hidden', 'x.TXT', 'x.a\\b', 'x.a b'];
    for (const name of samples) {
      expect(safeKeyExtension('video/mp4', name)).toMatch(
        /^(\.[a-z0-9]{1,8})?$/,
      );
    }
  });
});

// A LinkedIn Document post's file: the Documents API's five types, 100 MB.
describe('CloudflareR2Service composer-document presign', () => {
  const env: Record<string, string> = {
    CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    CLOUDFLARE_R2_BUCKET: 'bucket',
    CLOUDFLARE_R2_PUBLIC_URL: 'https://pub.r2.dev',
  };
  const service = new CloudflareR2Service({
    get: (name: string, fallback?: string) => env[name] ?? fallback,
  } as unknown as ConfigService);
  const presign = (contentType: string, sizeBytes = 1024, filename?: string) =>
    service.createPresignedUpload({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'composer-document',
      contentType,
      sizeBytes,
      filename,
    });

  it.each([
    ['application/pdf', 'deck.pdf', '.pdf'],
    ['application/msword', 'brief.doc', '.doc'],
    ['application/vnd.ms-powerpoint', 'deck.ppt', '.ppt'],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'deck.pptx',
      '.pptx',
    ],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
      '.docx',
    ],
  ])('takes %s under composer/documents', async (type, name, ext) => {
    const res = await presign(type, 1024, name);
    expect(res.key).toMatch(
      /^composer\/documents\/ws-1\/user-1\/\d+-[0-9a-f]{24}\.[a-z]+$/,
    );
    expect(res.key.endsWith(ext)).toBe(true);
    expect(res.publicUrl).toBe(`https://pub.r2.dev/${res.key}`);
  });

  it.each(['image/png', 'video/mp4', 'text/plain', 'application/zip', ''])(
    'refuses %s',
    async (type) => {
      await expect(presign(type)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('refuses a file over 100 MB and takes one at exactly 100 MB', async () => {
    const limit = 100 * 1024 * 1024;
    await expect(presign('application/pdf', limit + 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(presign('application/pdf', limit)).resolves.toBeDefined();
  });
});

// A 42 MB video on a ~1 Mbps uplink needs ~5.5 minutes just to send: the URL
// must outlive that, scaled to the file, while small files keep five minutes.
describe('presignExpirySeconds', () => {
  const MB = 1024 * 1024;

  it('keeps five minutes for small files', () => {
    expect(presignExpirySeconds(0)).toBe(PRESIGN_MIN_SECONDS);
    expect(presignExpirySeconds(1)).toBe(PRESIGN_MIN_SECONDS + 1);
    expect(presignExpirySeconds(-5)).toBe(PRESIGN_MIN_SECONDS);
  });

  it('gives a 42 MB file the time to send it at 128 KiB/s plus five minutes', () => {
    // 42 MB / 128 KiB/s = 336 s of sending.
    expect(presignExpirySeconds(42 * MB)).toBe(336 + 300);
    expect(presignExpirySeconds(42 * MB)).toBeGreaterThan(5 * 60);
  });

  it('grows with the file and caps at 12 hours', () => {
    expect(presignExpirySeconds(100 * MB)).toBeGreaterThan(
      presignExpirySeconds(42 * MB),
    );
    // 4 GB (the composer-video cap) is ~9 hours at 1 Mbps, still under it.
    expect(presignExpirySeconds(4 * 1024 * MB)).toBe(32768 + 300);
    expect(presignExpirySeconds(10 * 1024 * MB)).toBe(PRESIGN_MAX_SECONDS);
  });

  it('is what a composer-video presign reports', async () => {
    const service = new CloudflareR2Service({
      get: (name: string, fallback?: string) =>
        ({
          CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
          CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
          CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
          CLOUDFLARE_R2_BUCKET: 'bucket',
        })[name] ?? fallback,
    } as unknown as ConfigService);
    const res = await service.createPresignedUpload({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'composer-video',
      contentType: 'video/mp4',
      sizeBytes: 42 * MB,
      filename: 'clip.mp4',
    });
    expect(res.expiresIn).toBe(636);
    expect(new URL(res.uploadUrl).searchParams.get('X-Amz-Expires')).toBe(
      '636',
    );
  });
});
