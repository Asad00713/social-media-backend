import { fetch as undiciFetch } from 'undici';
import { assertPublicUrl, publicAgent } from '../../common/net/public-fetch';
import type { SavedLinkUtm } from '../../drizzle/schema/media-library.schema';

export {
  assertPublicUrl,
  checkedLookup,
  isPrivateAddress,
} from '../../common/net/public-fetch';

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

interface Capped {
  doc: string;
  /** `doc` lower-cased once (ASCII only, same length), shared by every scanner. */
  lower: string;
}

/**
 * The part of the page worth scanning: cut at the first </head> or 64 KB,
 * whichever comes first. Every extractor sees only this, and no regex ever
 * runs over it (ReDoS). Lower-cased once here.
 */
function capHtml(html: string): Capped {
  const head = html.slice(0, MAX_SCAN_CHARS);
  const lowerHead = asciiLower(head);
  const end = lowerHead.indexOf('</head>');
  return end === -1
    ? { doc: head, lower: lowerHead }
    : { doc: head.slice(0, end), lower: lowerHead.slice(0, end) };
}

/**
 * Index of the `>` that closes the tag opened at `start`, skipping quoted
 * attribute values. A quote with no closing partner before the cap is treated
 * as plain text, so the tag ends at the next `>`. Linear: one forward pass,
 * and `lastQuote` answers "is there any closing quote left" without rescanning.
 */
function tagEnd(
  doc: string,
  start: number,
  lastQuote: { '"': number; "'": number },
): number {
  for (let i = start + 1; i < doc.length; i++) {
    const c = doc.charAt(i);
    if (c === '>') return i;
    if ((c === '"' || c === "'") && lastQuote[c] > i) {
      i = doc.indexOf(c, i + 1);
    }
  }
  return -1;
}

/** Every `<name ...>` tag in the capped doc, by linear scan. */
function tagsNamed({ doc, lower }: Capped, name: string): string[] {
  const open = `<${name}`;
  const lastQuote = { '"': doc.lastIndexOf('"'), "'": doc.lastIndexOf("'") };
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start === -1) break;
    const close = tagEnd(doc, start, lastQuote);
    if (close === -1) break;
    const next = lower.charAt(start + open.length);
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
function titleText({ doc, lower: lowerDoc }: Capped): string | undefined {
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

function faviconFrom(capped: Capped, pageUrl: string): string {
  const page = new URL(pageUrl);
  const fallback = `${page.origin}/favicon.ico`;
  let icon: string | undefined;
  let apple: string | undefined;

  for (const tag of tagsNamed(capped, 'link')) {
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
  const capped = capHtml(html);
  const meta = new Map<string, string>();
  for (const tag of tagsNamed(capped, 'meta')) {
    const attrs = parseAttrs(tag);
    const key = asciiLower(attrs.get('property') ?? attrs.get('name') ?? '');
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  return {
    title: meta.get('og:title') || titleText(capped) || undefined,
    description:
      meta.get('og:description') || meta.get('description') || undefined,
    imageUrl: meta.get('og:image') || undefined,
    siteName: meta.get('og:site_name') || undefined,
    faviconUrl: faviconFrom(capped, pageUrl),
  };
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// Links are user-supplied URLs fetched server-side, so the target must be a
// public host. The address checks and the pinned-lookup agent live in
// common/net/public-fetch, shared with the publishers' media downloads.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

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
