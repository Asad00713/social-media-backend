import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  isSampleAssetUrl,
  sampleAssetBaseUrl,
  sampleAssetUrl,
  sampleAssetsDir,
  sampleAssetsMiddleware,
} from './sample-assets';
import {
  SAMPLE_ASSET_ROUTE,
  SAMPLE_ASSET_VERSION,
  SAMPLE_IMAGES,
  SAMPLE_LINK,
  SAMPLE_SNIPPETS,
  SAMPLE_TEMPLATES,
} from './sample-content';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const fileOf = (name: string) =>
  join(sampleAssetsDir(), SAMPLE_ASSET_VERSION, name);

describe('sample content manifest', () => {
  it('has 6 to 8 images, a few hundred KB in all', () => {
    expect(SAMPLE_IMAGES.length).toBeGreaterThanOrEqual(6);
    expect(SAMPLE_IMAGES.length).toBeLessThanOrEqual(8);
    const total = SAMPLE_IMAGES.reduce((s, i) => s + i.bytes, 0);
    expect(total).toBeLessThan(500 * 1024);
  });

  it.each(SAMPLE_IMAGES.map((i) => [i.file, i] as const))(
    '%s on disk matches its size and dimensions',
    (file, img) => {
      const buf = readFileSync(fileOf(file));
      expect(statSync(fileOf(file)).size).toBe(img.bytes);
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR: width and height are the first two fields after its type.
      expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
      expect(buf.readUInt32BE(16)).toBe(img.width);
      expect(buf.readUInt32BE(20)).toBe(img.height);
      expect(img.name.trim()).not.toBe('');
      expect(img.altText.trim()).not.toBe('');
    },
  );

  it('3-4 templates, 3 snippets and a link, each with real copy', () => {
    expect(SAMPLE_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(SAMPLE_TEMPLATES.length).toBeLessThanOrEqual(4);
    expect(SAMPLE_SNIPPETS).toHaveLength(3);
    const files = new Set(SAMPLE_IMAGES.map((i) => i.file));
    for (const t of SAMPLE_TEMPLATES) {
      expect(files.has(t.imageFile)).toBe(true);
      expect(t.text.length).toBeGreaterThan(40);
    }
    for (const s of SAMPLE_SNIPPETS)
      expect(s.content.length).toBeGreaterThan(10);
    expect(new URL(SAMPLE_LINK.url).hostname).toBe('example.com');
  });
});

describe('sample asset URLs', () => {
  it('uses API_PUBLIC_URL, then APP_URL, without a trailing slash', () => {
    expect(
      sampleAssetBaseUrl({
        API_PUBLIC_URL: 'https://api.example.test/',
        APP_URL: 'https://app.example.test',
      } as NodeJS.ProcessEnv),
    ).toBe('https://api.example.test');
    expect(
      sampleAssetBaseUrl({
        APP_URL: ' http://localhost:8000 ',
      } as NodeJS.ProcessEnv),
    ).toBe('http://localhost:8000');
  });

  it('is null without a usable http(s) origin', () => {
    expect(sampleAssetBaseUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      sampleAssetBaseUrl({ APP_URL: 'api.example.test' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a versioned absolute URL and recognises it', () => {
    const url = sampleAssetUrl('https://api.example.test', 'quick-tip.png');
    expect(url).toBe(
      'https://api.example.test/static/library-samples/v1/quick-tip.png',
    );
    expect(isSampleAssetUrl(url)).toBe(true);
    expect(isSampleAssetUrl('https://res.cloudinary.com/x/quick-tip.png')).toBe(
      false,
    );
    expect(isSampleAssetUrl('not a url')).toBe(false);
    expect(isSampleAssetUrl(null)).toBe(false);
  });
});

describe('sample asset route', () => {
  const app = express();
  app.use(SAMPLE_ASSET_ROUTE, sampleAssetsMiddleware());
  const path = (file: string) =>
    `${SAMPLE_ASSET_ROUTE}/${SAMPLE_ASSET_VERSION}/${file}`;

  it('serves a sample publicly, cacheable for a year and cross-origin', async () => {
    const img = SAMPLE_IMAGES[0];
    const res = await request(app).get(path(img.file));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Number(res.headers['content-length'])).toBe(img.bytes);
  });

  it('404s a missing file and the folder itself; refuses a path outside it', async () => {
    expect((await request(app).get(path('nope.png'))).status).toBe(404);
    expect(
      (await request(app).get(`${SAMPLE_ASSET_ROUTE}/${SAMPLE_ASSET_VERSION}/`))
        .status,
    ).toBe(404);
    const escape = await request(app).get(
      `${SAMPLE_ASSET_ROUTE}/..%2f..%2fpackage.json`,
    );
    expect([403, 404]).toContain(escape.status);
  });
});
