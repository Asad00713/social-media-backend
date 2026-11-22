import { isIP } from 'net';

type HeaderValue = string | string[] | undefined;

export interface ClientIpRequest {
  headers?: Record<string, HeaderValue>;
  ip?: string;
}

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
 * The visitor's address behind Railway's edge, or `null` when the request
 * carries none.
 *
 * The app does not set `trust proxy`, so `req.ip` is the proxy for every
 * visitor. The LEFTMOST `X-Forwarded-For` entry is whatever the caller sent,
 * so it is never believed. Order:
 *   1. `X-Real-IP`: Railway's edge sets/overwrites it with the client's
 *      remote IP on every request.
 *   2. the RIGHTMOST non-empty `X-Forwarded-For` entry: the edge appends the
 *      address it saw, so only the last hop is not client-controlled.
 *   3. `req.ip`.
 * IPv4-in-IPv6 (`::ffff:1.2.3.4`) is unmapped so one visitor has one form.
 * Anything that is not an IP address after that (a garbage header, a value
 * too long for the `varchar(45)` it is stored in) is `null`, never stored.
 * Only the chosen source is validated: an invalid X-Real-IP does not fall
 * through to the client-controlled X-Forwarded-For.
 *
 * Shared by the IP throttler (its bucket key) and the session issuer (the
 * address stored on a session and looked up for its country).
 */
export function requestClientIp(req: ClientIpRequest): string | null {
  const headers = req.headers ?? {};
  const raw =
    singleValue(headers['x-real-ip']) ??
    lastEntry(headers['x-forwarded-for']) ??
    (req.ip?.trim() || undefined);
  if (!raw) return null;
  const ip = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
  return isIP(ip) ? ip : null;
}
