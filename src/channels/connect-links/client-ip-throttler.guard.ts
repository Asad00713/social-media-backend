import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

type HeaderValue = string | string[] | undefined;

/** First non-blank value of a header that may arrive as a string or an array. */
function singleValue(header: HeaderValue): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.trim() || undefined;
}

/** The last non-blank entry of a comma separated list (X-Forwarded-For). */
function lastEntry(header: HeaderValue): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return entries[entries.length - 1];
}

/**
 * ThrottlerGuard that buckets by the visitor, not by the proxy in front of us.
 *
 * The app does not set `trust proxy`, and in production it runs behind
 * Railway's edge, so `req.ip` is the proxy address for every visitor and one
 * shared bucket would 429 real clients. Which header to believe matters: the
 * LEFTMOST `X-Forwarded-For` entry is whatever the caller sent, so rotating it
 * would dodge the limit. Order used here:
 *   1. `X-Real-IP`: Railway's edge sets/overwrites it with the client's remote
 *      IP on every request (Railway staff:
 *      https://station.railway.com/questions/which-header-should-i-rely-on-for-real-c-d78a6f96).
 *   2. the RIGHTMOST non-empty `X-Forwarded-For` entry: the edge appends the
 *      address it saw, so only the last hop is not client-controlled.
 *   3. `req.ip`.
 * Scoped to the public connect-link controller on purpose; the app-wide
 * setting is not changed here.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, HeaderValue>;
    return Promise.resolve(
      singleValue(headers['x-real-ip']) ??
        lastEntry(headers['x-forwarded-for']) ??
        (req.ip as string),
    );
  }
}
