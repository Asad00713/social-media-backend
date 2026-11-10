import {
  extractPageMeta,
  fetchPublicHtml,
} from '../../media-library/lib/link-meta';

/**
 * What a page says about itself - title, description and image - read the
 * way the media library's saved links and the composer's AI assist read it:
 * through `fetchPublicHtml` (public hosts only, every redirect hop re-checked,
 * 8 s, 1 MB) and `extractPageMeta` (the capped head, no regex over the page).
 * A client-supplied URL is never fetched any other way.
 *
 * Used by the composer's link-preview endpoint (to prefill a Facebook
 * carousel card) and by the Facebook publisher (to find a card's picture
 * when the draft has none).
 */

/** The longest title / description kept from a page; the rest is noise. */
export const LINK_PREVIEW_MAX_TEXT = 300;

const USER_AGENT =
  'Mozilla/5.0 (compatible; SocialMediaBot/1.0; +https://example.com)';

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  /** Absolute and https - a picture Facebook (and a browser) can load. */
  imageUrl?: string;
  siteName?: string;
  /** False when the page could not be fetched at all. */
  isReadable: boolean;
}

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, LINK_PREVIEW_MAX_TEXT) : undefined;
}

/**
 * `og:image` as an absolute https URL, or undefined. Relative and
 * protocol-relative values resolve against the page actually served; an
 * http image is dropped rather than upgraded - it may not exist on https.
 */
export function absoluteHttpsImage(
  raw: string | undefined,
  pageUrl: string,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const resolved = new URL(value, pageUrl);
    return resolved.protocol === 'https:' ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws: an unreadable page is `isReadable: false`, not an error. */
export async function readLinkPreview(url: string): Promise<LinkPreview> {
  let page: { html: string; finalUrl: string } | null = null;
  try {
    page = await fetchPublicHtml(url, { 'User-Agent': USER_AGENT });
  } catch {
    // A private address, a timeout, a refused connection: all "unreadable".
    page = null;
  }
  if (!page) return { url, isReadable: false };

  const meta = extractPageMeta(page.html, page.finalUrl);
  return {
    url,
    title: clean(meta.title),
    description: clean(meta.description),
    imageUrl: absoluteHttpsImage(meta.imageUrl, page.finalUrl),
    siteName: clean(meta.siteName),
    isReadable: true,
  };
}
