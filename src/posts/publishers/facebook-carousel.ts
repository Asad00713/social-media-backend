import { readLinkPreview } from '../lib/link-preview';

/**
 * A Facebook link carousel - `child_attachments` on `POST /{page-id}/feed`.
 *
 * Meta's Page feed reference (developers.facebook.com/docs/graph-api/
 * reference/page/feed), STATED:
 *   - child_attachments: "Use to specify multiple links in the post. Minimum
 *     2 and maximum of 5 objects."
 *   - each child's `link`: "This field is required", and either `picture` or
 *     `image_hash` must be provided.
 *   - `name`: "If not specified, the title of the linked page will be used."
 *   - `description`: "Used to show either a price, discount or website
 *     domain", "typically truncated after 30 characters".
 *   - multi_share_optimized: "If set to true and only when the post is used
 *     in an ad, Facebook will automatically select the order" (default true).
 *
 * The draft's own key is `carouselLinks` - `platformSpecific` reaches the
 * publisher as `metadata` verbatim, so the composer writes exactly this name.
 */

export const FACEBOOK_CAROUSEL_MIN = 2;
export const FACEBOOK_CAROUSEL_MAX = 5;

/** One card as the draft stores it. */
export interface CarouselLinkInput {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

/** One card as Facebook takes it. */
export interface CarouselCard {
  link: string;
  picture: string;
  name?: string;
  description?: string;
}

function isHttps(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * Does this post go out as a carousel? Only a `Post` with no media: a Reel
 * and a Story are their own formats, and attaching a photo makes the post a
 * photo post (the link stays in the caption as text) - a carousel saved
 * before that is left unsent, as the link button is.
 *
 * An absent key or an empty list is no carousel; anything else is one, and
 * `carouselErrors` says whether it can be sent.
 */
export function wantsCarousel(
  metadata: Record<string, unknown> | undefined,
  mediaCount: number,
): boolean {
  const postType = (metadata?.postType as string | undefined) ?? 'post';
  if (postType === 'reel' || postType === 'story') return false;
  if (mediaCount > 0) return false;
  const raw = metadata?.carouselLinks;
  if (raw === undefined || raw === null) return false;
  return !Array.isArray(raw) || raw.length > 0;
}

/** Every reason the draft's carousel cannot be sent, in card order. */
export function carouselErrors(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const raw = metadata?.carouselLinks;
  if (!Array.isArray(raw)) return ['Facebook carousel links must be a list'];
  const errors: string[] = [];
  if (
    raw.length < FACEBOOK_CAROUSEL_MIN ||
    raw.length > FACEBOOK_CAROUSEL_MAX
  ) {
    errors.push(
      `A Facebook carousel takes ${FACEBOOK_CAROUSEL_MIN} to ${FACEBOOK_CAROUSEL_MAX} links; this one has ${raw.length}`,
    );
  }
  raw.forEach((item: unknown, i) => {
    const card = (item ?? {}) as Record<string, unknown>;
    if (!isHttps(card.url)) {
      errors.push(`Carousel link ${i + 1} must be an https:// URL`);
    }
    if (card.imageUrl !== undefined && !isHttps(card.imageUrl)) {
      errors.push(`Carousel link ${i + 1}'s image must be an https:// URL`);
    }
  });
  return errors;
}

/** The draft's cards, trimmed. Call after `carouselErrors` came back empty. */
export function carouselLinks(
  metadata: Record<string, unknown> | undefined,
): CarouselLinkInput[] {
  const raw = (metadata?.carouselLinks ?? []) as Record<string, unknown>[];
  return raw.map((card) => ({
    url: String(card.url).trim(),
    title: text(card.title),
    description: text(card.description),
    imageUrl: text(card.imageUrl),
  }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The cards as Facebook takes them, with a picture for every one.
 *
 * The draft's own image wins. A card without one has its page read for its
 * `og:image` - through `readLinkPreview`, the SSRF-safe reader - and, while
 * the page is open anyway, its title when the draft has none. A card still
 * without a picture fails the post: Facebook requires one, and a post sent
 * without it would be refused whole.
 */
export async function resolveCarouselCards(
  links: CarouselLinkInput[],
  read: typeof readLinkPreview = readLinkPreview,
): Promise<CarouselCard[]> {
  return Promise.all(
    links.map(async (link, i) => {
      let picture = link.imageUrl;
      let name = link.title;
      if (!picture) {
        const preview = await read(link.url);
        picture = preview.imageUrl;
        name ??= preview.title;
      }
      if (!picture) {
        throw new Error(
          `Facebook carousel card ${i + 1} (${hostOf(link.url)}) has no image, and Facebook needs one on every card. Add an image to that card.`,
        );
      }
      return {
        link: link.url,
        picture,
        ...(name ? { name } : {}),
        ...(link.description ? { description: link.description } : {}),
      };
    }),
  );
}
