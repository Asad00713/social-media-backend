import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/neon-http';
import { neon, neonConfig } from '@neondatabase/serverless';
import * as schema from './schema';

/**
 * Transient-friendly fetch wrapper for Neon's HTTP transport.
 *
 * Serverless DB calls go over plain HTTPS from our backend → Neon's regional
 * proxy. The most common runtime failure mode is a transient connection
 * timeout (UND_ERR_CONNECT_TIMEOUT) when the developer's ISP route to AWS
 * APAC bounces, or when Neon's edge briefly drops the connection. Those
 * present as a Node `fetch failed` rejection inside Drizzle, surfacing as
 * a 401 to the user (because most call paths originate from
 * JwtRefreshStrategy.validate → users.findOne).
 *
 * Strategy:
 *   - Per-attempt deadline (30 s) via AbortController to bound any single try.
 *   - Up to 3 attempts on transient errors with exponential backoff
 *     (250 ms → 500 ms → 1000 ms).
 *   - Retry network errors and 5xx HTTP responses; 4xx is real and surfaces
 *     verbatim.
 *
 * The retries are intentionally short so they don't compound latency for
 * real outages — long Neon downtime still surfaces as a normal error after
 * ~2 s of trying.
 */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const PER_ATTEMPT_TIMEOUT_MS = 30_000;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (code) {
    if (
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'ENOTFOUND'
    ) {
      return true;
    }
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('connect timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

neonConfig.fetchFunction = async (url: RequestInfo, options?: RequestInit) => {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      PER_ATTEMPT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // Retry 5xx (transient server-side); pass everything else through.
      if (response.status >= 500 && response.status < 600 && attempt + 1 < MAX_ATTEMPTS) {
        lastErr = new Error(`Neon ${response.status} ${response.statusText}`);
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      // Only retry on transient network errors — real auth / query bugs
      // should surface immediately so we don't mask them with delay.
      if (!isTransientError(err) || attempt + 1 >= MAX_ATTEMPTS) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[db] Neon fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${
          (err as Error).message
        }); retrying in ${BASE_BACKOFF_MS * 2 ** attempt}ms`,
      );
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastErr;
};

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

export type DbType = typeof db;
