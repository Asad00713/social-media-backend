import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { SAMPLE_ASSET_ROUTE, SAMPLE_ASSET_VERSION } from './sample-content';

/**
 * Where the bundled sample images live at runtime. The process runs from the
 * repo root (the migration runner relies on the same thing), and the
 * Dockerfile copies `assets/` into the production image.
 */
export function sampleAssetsDir(): string {
  return join(process.cwd(), 'assets', 'library-samples');
}

/**
 * The API's own public origin, e.g. `https://api.schedura.com`, from the same
 * env chain as the other public callbacks (`API_PUBLIC_URL`, then `APP_URL`).
 * Null when neither is an http(s) URL: sample media then is not seeded, since
 * a relative or broken URL would fail when a post is published.
 */
export function sampleAssetBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = (env.API_PUBLIC_URL || env.APP_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return /^https?:\/\/[^/]+/i.test(base) ? base : null;
}

/** The absolute, public URL of one bundled sample file. */
export function sampleAssetUrl(base: string, file: string): string {
  return `${base}${SAMPLE_ASSET_ROUTE}/${SAMPLE_ASSET_VERSION}/${file}`;
}

/** Whether a URL is one of the bundled sample files (any version, any host). */
export function isSampleAssetUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.startsWith(`${SAMPLE_ASSET_ROUTE}/`);
  } catch {
    return false;
  }
}

/**
 * Serves the bundled sample images, mounted at SAMPLE_ASSET_ROUTE in main.ts
 * before Nest's routes: public (no auth), cacheable for a year as immutable
 * (each version is its own folder), and readable cross-origin so the web
 * app's image editors and the platforms that fetch a published post's media
 * can load them. A missing file is a 404 here, not a fall-through.
 */
export function sampleAssetsMiddleware(
  dir: string = sampleAssetsDir(),
): RequestHandler {
  return express.static(dir, {
    index: false,
    dotfiles: 'ignore',
    redirect: false,
    fallthrough: false,
    immutable: true,
    maxAge: '365d',
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
}
