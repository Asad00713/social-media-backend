import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

// ── SSRF guard ──────────────────────────────────────────────────────────────
// Client-supplied URLs (link previews, draft media, thumbnails) are fetched
// server-side, so the target must be a public host. Addresses are classified
// with ipaddr.js; the connect-time DNS lookup re-checks and pins them, so a
// rebinding answer cannot slip through.

const DENY_CIDRS = [
  '198.18.0.0/15',
  '64:ff9b:1::/48',
  'fec0::/10',
  '100::/64',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '2001:db8::/32',
].map((c) => ipaddr.parseCIDR(c));

/**
 * True unless `address` is a globally routable unicast address. Mapped IPv6 is
 * unwrapped to its IPv4. IPv6 forms that embed an IPv4 address (IPv4-compatible
 * ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo) are REJECTED outright
 * rather than unwrapped. Ranges ipaddr.js 1.9.1 mislabels as unicast (TEST-NETs,
 * 198.18/15, 240/4, fec0::/10, 100::/64, ...) are caught by DENY_CIDRS.
 * Unparseable input counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(address);
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv6') {
    const parts = (addr as ipaddr.IPv6).parts;
    if (parts.slice(0, 6).every((p) => p === 0)) return true; // ::/96
  }
  if (addr.range() !== 'unicast') return true;
  // ipaddr.js 1.9.1 calls these non-global ranges 'unicast'.
  return DENY_CIDRS.some(
    ([net, bits]) =>
      net.kind() === addr.kind() &&
      (addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits),
  );
}

interface LookupResult {
  address: string;
  family: number;
}
type LookupCallback = (
  err: Error | null,
  addrs: LookupResult[] | string,
  family?: number,
) => void;
type Resolver = (
  host: string,
  options: { all: true },
  cb: (err: Error | null, addrs: LookupResult[]) => void,
) => void;

/**
 * undici connect-time lookup: resolve, fail if ANY address is non-public, and
 * hand back only the checked addresses, so the socket connects to exactly what
 * was verified. `resolver` is injectable for tests.
 */
export function checkedLookup(
  host: string,
  options: unknown,
  callback: LookupCallback,
  resolver: Resolver = dnsLookup as unknown as Resolver,
): void {
  resolver(host, { all: true }, (err, addrs) => {
    if (err) return callback(err, []);
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error('Link points at a private address'), []);
    }
    if ((options as { all?: boolean } | null)?.all) {
      return callback(null, addrs);
    }
    callback(null, addrs[0].address, addrs[0].family);
  });
}

/** undici dispatcher whose every connection goes through `checkedLookup`. */
export const publicAgent = new Agent({
  connect: {
    lookup: ((host: string, options: unknown, cb: LookupCallback) =>
      checkedLookup(host, options, cb)) as never,
  },
});

/** Throws unless `url` is http(s) and, for IP literals, a public address. */
export function assertPublicUrl(url: string): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error('Only http(s) links can be fetched'));
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  // Literals skip the connect-time lookup, so they are checked here. Hostnames
  // are checked and pinned at connect time by checkedLookup.
  if (isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new Error('Link points at a private address'));
  }
  return Promise.resolve(parsed);
}

// ── Media downloads ─────────────────────────────────────────────────────────

/** Most images we publish are a few MB; 50 MB is far above any platform cap. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** The largest composer upload we accept (R2 `composer-video`), 4 GB. */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MEDIA_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The download target is not a public http(s) host, or the body is too big. */
export class UnsafeMediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeMediaUrlError';
  }
}

export interface PublicMediaInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Body cap in bytes. Defaults to MAX_MEDIA_BYTES. */
  maxBytes?: number;
}

/**
 * Error the body stream once it passes `maxBytes`, so a caller that buffers
 * (`arrayBuffer()`) fails instead of filling memory, and a caller that streams
 * keeps streaming.
 */
function capBody(response: Response, maxBytes: number): Response {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new UnsafeMediaUrlError(
      `Media is ${declared} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  if (!response.body) return response;
  let seen = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new UnsafeMediaUrlError(`Media is over the ${maxBytes}-byte limit`),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * GET a client-supplied media URL (draft image/video/thumbnail/document) for
 * re-upload to a platform. Drop-in for `fetch(url)`:
 *
 * - http(s) only; IP literals that are private, loopback, link-local or cloud
 *   metadata are refused before any request is made;
 * - hostnames are resolved, checked and pinned at connect time (no DNS
 *   rebinding);
 * - redirects are followed by hand, at most 5 hops, each hop re-checked;
 * - the body is capped at `maxBytes` (default 4 GB) without breaking streaming.
 *
 * Throws UnsafeMediaUrlError (or the connect-time lookup's error, wrapped by
 * undici as a `fetch failed` TypeError) for a refused target. A non-2xx answer
 * is returned as-is, exactly like `fetch`.
 */
export async function fetchPublicMedia(
  url: string,
  init: PublicMediaInit = {},
): Promise<Response> {
  const maxBytes = init.maxBytes ?? MAX_MEDIA_BYTES;
  let current = url;
  for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
    try {
      await assertPublicUrl(current);
    } catch (err) {
      throw new UnsafeMediaUrlError(
        `Refusing to fetch media from ${current}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const response = (await undiciFetch(current, {
      headers: init.headers,
      signal: init.signal,
      redirect: 'manual',
      dispatcher: publicAgent,
    })) as unknown as Response;
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    return response.ok ? capBody(response, maxBytes) : response;
  }
  throw new UnsafeMediaUrlError(
    `Too many redirects fetching media from ${url}`,
  );
}
