import { lookup } from 'dns/promises';
import { isIP } from 'net';
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

const LINK_TAG = /<link\b[^>]*>/gi;

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(
    new RegExp(
      String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`,
      'i',
    ),
  );
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
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

  for (const tag of html.match(LINK_TAG) ?? []) {
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
// public host. Hostnames are resolved and every address checked.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export function isPrivateAddress(address: string): boolean {
  const v4mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateAddress(v4mapped[1]);

  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      /^fe[89ab]/.test(a) ||
      a.startsWith('ff')
    );
  }
  return true; // not an IP we understand: refuse
}

/** Throws unless `url` is http(s) and every address it resolves to is public. */
export async function assertPublicUrl(url: string): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) links can be fetched');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Link points at a private address');
  }
  return parsed;
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
  return text;
}

/**
 * GET a page's HTML for preview scraping: public hosts only (each redirect hop
 * re-checked), 8s timeout, 1 MB cap. Returns the final URL so relative hrefs
 * resolve against the page actually served. Null when the page is unusable.
 */
export async function fetchPublicHtml(
  url: string,
  headers: Record<string, string>,
): Promise<{ html: string; finalUrl: string } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) return null;
    return { html: await readCapped(response), finalUrl: current };
  }
  return null;
}
