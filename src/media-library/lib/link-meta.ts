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

/** ASCII-only lowercase: unlike toLowerCase() it never changes the length. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The part of the page worth scanning: cut at the first </head> or 64 KB,
 * whichever comes first. Every extractor sees only this string, and no regex
 * ever runs over it (ReDoS).
 */
function capHtml(html: string): string {
  const head = html.slice(0, MAX_SCAN_CHARS);
  const end = asciiLower(head).indexOf('</head>');
  return end === -1 ? head : head.slice(0, end);
}

/** Every `<name ...>` tag in `doc`, by linear indexOf scan. */
function tagsNamed(doc: string, lowerDoc: string, name: string): string[] {
  const open = `<${name}`;
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = lowerDoc.indexOf(open, from);
    if (start === -1) break;
    const close = lowerDoc.indexOf('>', start);
    if (close === -1) break;
    const next = lowerDoc.charAt(start + open.length);
    if (WS.has(next) || next === '/' || next === '>') {
      tags.push(doc.slice(start, close + 1));
    }
    from = close + 1;
  }
  return tags;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/** Decode the five basic entities in an already-extracted value. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39|#x27);/gi,
    (m) => ENTITIES[m.toLowerCase()] ?? m,
  );
}

function isNameEnd(c: string): boolean {
  return WS.has(c) || c === '=' || c === '>' || c === '/';
}

/** Attributes of one tag (lower-cased names), by a single linear pass. */
function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 1; // past '<'
  while (i < tag.length && !WS.has(tag.charAt(i)) && tag.charAt(i) !== '>') i++;
  while (i < tag.length) {
    while (i < tag.length && (WS.has(tag.charAt(i)) || tag.charAt(i) === '/')) {
      i++;
    }
    if (i >= tag.length || tag.charAt(i) === '>') break;
    let n = i;
    while (n < tag.length && !isNameEnd(tag.charAt(n))) n++;
    if (n === i) {
      i++; // stray '=': skip it so the scan always advances
      continue;
    }
    const name = asciiLower(tag.slice(i, n));
    i = n;
    while (WS.has(tag.charAt(i))) i++;
    if (tag.charAt(i) !== '=') {
      if (!attrs.has(name)) attrs.set(name, '');
      continue;
    }
    i++;
    while (WS.has(tag.charAt(i))) i++;
    const q = tag.charAt(i);
    let value: string;
    if (q === '"' || q === "'") {
      const e = tag.indexOf(q, i + 1);
      value = e === -1 ? tag.slice(i + 1) : tag.slice(i + 1, e);
      i = e === -1 ? tag.length : e + 1;
    } else {
      let e = i;
      while (
        e < tag.length &&
        !WS.has(tag.charAt(e)) &&
        tag.charAt(e) !== '>'
      ) {
        e++;
      }
      value = tag.slice(i, e);
      i = e;
    }
    if (!attrs.has(name)) attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

/** Text between `<title ...>` and `</title>`, or undefined. */
function titleText(doc: string, lowerDoc: string): string | undefined {
  const open = '<title';
  let from = 0;
  for (;;) {
    const start = lowerDoc.indexOf(open, from);
    if (start === -1) return undefined;
    const gt = lowerDoc.indexOf('>', start);
    if (gt === -1) return undefined;
    const next = lowerDoc.charAt(start + open.length);
    if (WS.has(next) || next === '>') {
      const end = lowerDoc.indexOf('</title', gt);
      if (end === -1) return undefined;
      return decodeEntities(doc.slice(gt + 1, end).trim());
    }
    from = gt + 1;
  }
}

/**
 * The page's favicon as an absolute http(s) URL. `rel` is split into tokens
 * and matched as tokens, so `apple-touch-icon` never counts as `icon` and the
 * answer does not depend on attribute or tag order. Falls back to
 * `<origin>/favicon.ico`.
 */
export function extractFavicon(html: string, pageUrl: string): string {
  return faviconFrom(capHtml(html), pageUrl);
}

function faviconFrom(doc: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const fallback = `${page.origin}/favicon.ico`;
  let icon: string | undefined;
  let apple: string | undefined;

  for (const tag of tagsNamed(doc, asciiLower(doc), 'link')) {
    const attrs = parseAttrs(tag);
    const rel = attrs.get('rel');
    const href = attrs.get('href')?.trim();
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
    const tokens = asciiLower(rel).split(/\s+/);
    if (tokens.includes('icon')) icon ??= resolved.href;
    else if (tokens.includes('apple-touch-icon')) apple ??= resolved.href;
  }
  return icon ?? apple ?? fallback;
}

export interface PageMeta {
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  faviconUrl: string;
}

/** Open Graph / meta / title / favicon of a page, from the capped head only. */
export function extractPageMeta(html: string, pageUrl: string): PageMeta {
  const doc = capHtml(html);
  const lowerDoc = asciiLower(doc);
  const meta = new Map<string, string>();
  for (const tag of tagsNamed(doc, lowerDoc, 'meta')) {
    const attrs = parseAttrs(tag);
    const key = asciiLower(attrs.get('property') ?? attrs.get('name') ?? '');
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  return {
    title: meta.get('og:title') || titleText(doc, lowerDoc) || undefined,
    description:
      meta.get('og:description') || meta.get('description') || undefined,
    imageUrl: meta.get('og:image') || undefined,
    siteName: meta.get('og:site_name') || undefined,
    faviconUrl: faviconFrom(doc, pageUrl),
  };
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
