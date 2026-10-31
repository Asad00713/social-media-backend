import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import type { SavedLinkUtm } from '../../drizzle/schema/media-library.schema';

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/** Trim every UTM value, drop the empty ones; nothing left means null. */
export function normalizeUtm(
  utm: SavedLinkUtm | null | undefined,
): SavedLinkUtm | null {
  if (!utm) return null;
  const out: SavedLinkUtm = {};
  for (const key of UTM_KEYS) {
    const value = utm[key]?.trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const MAX_SCAN_CHARS = 64 * 1024;
const WS = new Set([' ', '\t', '\n', '\r', '\f']);

/**
 * `<link ...>` tags from the head, found by a linear indexOf scan. No regex
 * runs over attacker HTML (ReDoS); scanning stops at </head> or 64 KB.
 */
function linkTags(html: string): string[] {
  const lower = html.slice(0, MAX_SCAN_CHARS).toLowerCase();
  const headEnd = lower.indexOf('</head>');
  const doc = headEnd === -1 ? lower : lower.slice(0, headEnd);
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = doc.indexOf('<link', from);
    if (start === -1) break;
    const close = doc.indexOf('>', start);
    if (close === -1) break;
    const next = doc.charAt(start + 5);
    if (WS.has(next) || next === '/') {
      tags.push(html.slice(start, close + 1));
    }
    from = close + 1;
  }
  return tags;
}

/** Value of attribute `name` in one tag, by linear scan. */
function attr(tag: string, name: string): string | undefined {
  const lower = tag.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(name, from);
    if (at === -1) return undefined;
    from = at + name.length;
    const prev = lower.charAt(at - 1);
    if (!WS.has(prev) && prev !== '"' && prev !== "'") continue;
    let k = from;
    while (WS.has(lower.charAt(k))) k++;
    if (lower.charAt(k) !== '=') continue;
    k++;
    while (WS.has(lower.charAt(k))) k++;
    const q = tag.charAt(k);
    if (q === '"' || q === "'") {
      const e = tag.indexOf(q, k + 1);
      return e === -1 ? undefined : tag.slice(k + 1, e);
    }
    let e = k;
    while (e < tag.length && !WS.has(tag.charAt(e)) && tag.charAt(e) !== '>') {
      e++;
    }
    return tag.slice(k, e);
  }
}

/**
 * The page's favicon as an absolute http(s) URL. `rel` is split into tokens
 * and matched as tokens, so `apple-touch-icon` never counts as `icon` and the
 * answer does not depend on attribute or tag order. Falls back to
 * `<origin>/favicon.ico`.
 */
export function extractFavicon(html: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const fallback = `${page.origin}/favicon.ico`;
  let icon: string | undefined;
  let apple: string | undefined;

  for (const tag of linkTags(html)) {
    const rel = attr(tag, 'rel');
    const href = attr(tag, 'href')?.trim();
    if (!rel || !href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, page);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      continue;
    }
    const tokens = rel.toLowerCase().split(/\s+/);
    if (tokens.includes('icon')) icon ??= resolved.href;
    else if (tokens.includes('apple-touch-icon')) apple ??= resolved.href;
  }
  return icon ?? apple ?? fallback;
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// Links are user-supplied URLs fetched server-side, so the target must be a
// public host. Addresses are classified with ipaddr.js; the connect-time DNS
// lookup re-checks and pins them, so a rebinding answer cannot slip through.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * True unless `address` is a globally routable unicast address. Mapped IPv6 is
 * unwrapped to its IPv4. IPv6 forms that embed an IPv4 address (IPv4-compatible
 * ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo) are REJECTED outright
 * rather than unwrapped. Unparseable input counts as private.
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
  return addr.range() !== 'unicast';
}

interface LookupResult {
  address: string;
  family: number;
}
type LookupCallback = (err: Error | null, addrs: LookupResult[]) => void;
type Resolver = (
  host: string,
  options: { all: true },
  cb: LookupCallback,
) => void;

/**
 * undici connect-time lookup: resolve, fail if ANY address is non-public, and
 * hand back only the checked addresses, so the socket connects to exactly what
 * was verified. `resolver` is injectable for tests.
 */
export function checkedLookup(
  host: string,
  _options: unknown,
  callback: LookupCallback,
  resolver: Resolver = dnsLookup as unknown as Resolver,
): void {
  resolver(host, { all: true }, (err, addrs) => {
    if (err) return callback(err, []);
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error('Link points at a private address'), []);
    }
    callback(null, addrs);
  });
}

const publicAgent = new Agent({
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

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_HTML_BYTES);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_HTML_BYTES - bytes;
    const chunk = value.byteLength > room ? value.subarray(0, room) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (bytes >= MAX_HTML_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

/**
 * GET a page's HTML for preview scraping: public hosts only (each redirect hop
 * re-checked, addresses pinned at connect), ONE 8s deadline for the whole
 * chain, 1 MB cap. Returns the final URL so relative hrefs resolve against the
 * page actually served. Null when the page is unusable.
 */
export async function fetchPublicHtml(
  url: string,
  headers: Record<string, string>,
): Promise<{ html: string; finalUrl: string } | null> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const response = (await undiciFetch(current, {
      headers,
      redirect: 'manual',
      signal,
      dispatcher: publicAgent,
    })) as unknown as Response;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return { html: await readCapped(response), finalUrl: current };
  }
  return null;
}
