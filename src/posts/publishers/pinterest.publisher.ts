import { Injectable } from '@nestjs/common';
import {
  BasePublisher,
  PartialPublishError,
  PublishOptions,
  PublishResult,
} from './base.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';
import {
  MediaItem,
  PublishItemResult,
} from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class PinterestPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'pinterest';

  constructor(private readonly pinterestService: PinterestService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { mediaItems, metadata } = options;

    // Pinterest requires media (image or video)
    if (mediaItems.length === 0) {
      throw new Error('Pinterest pins require an image or video');
    }

    // Pinterest requires a board ID. Composer sends it as `boardId`
    // (matches the validator + frontend PinterestFields); accept the legacy
    // `pinterestBoardId` too in case anything still emits the old name.
    const boardId = resolveBoardId(metadata);
    if (!boardId) {
      throw new Error('Pinterest board ID is required');
    }

    // Pinterest pins need a title — composer enforces this client-side,
    // but the publisher guards too.
    if (!metadata?.title?.trim()) {
      throw new Error('Pinterest pin title is required');
    }

    // Check media type
    const mediaType = mediaItems[0].type;
    if (mediaType !== 'image' && mediaType !== 'video') {
      throw new Error('Pinterest pins only support images and videos');
    }

    // Check title length (max 100 chars)
    if (metadata.title.length > 100) {
      throw new Error('Pinterest pin title cannot exceed 100 characters');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    // Pinterest supports images and videos
    return mediaItems.every((m) => m.type === 'image' || m.type === 'video');
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, metadata, previousItemResults } =
      options;

    this.validate(options);

    const boardId = resolveBoardId(metadata)!;
    const title = metadata?.title || content?.slice(0, 100) || 'Pin';
    // Composer sends `destinationLink` (matches the frontend PinterestFields).
    // Accept legacy `link` too for backwards compat.
    const link = metadata?.destinationLink ?? metadata?.link;
    const mediaType = mediaItems[0].type as 'image' | 'video';

    // Description priority: the Pinterest panel's Description field
    // (metadata.description) wins over any body text propagated from the
    // All-channels editor (content). Pinterest doesn't have a body editor —
    // its "caption" IS the description field, so user intent is in
    // metadata.description.
    const description = pickDescription(metadata, content);

    // Pinterest's `multiple_image_urls` source takes 2 to 5 images, so a
    // multi-image pin is a carousel rather than several pins. Only images:
    // the union has no mixed-media variant, and a video is its own upload
    // flow entirely.
    //
    // The composer offers two modes for several images: an explicit carousel
    // (this), or - the default - one Pin per image (below).
    const extraImageUrls =
      mediaType === 'image' && metadata?.asCarousel === true
        ? mediaItems
            .slice(1)
            .filter((m) => m.type === 'image')
            .map((m) => m.url)
        : [];

    // One Pin per image: several images that are NOT an explicit carousel.
    // Each Pin carries the same title, description, link, board, section and
    // disclosure, and its own photo's alt text.
    const images = mediaItems.filter((m) => m.type === 'image');
    if (
      mediaType === 'image' &&
      metadata?.asCarousel !== true &&
      images.length > 1
    ) {
      return this.publishPinPerImage(images, previousItemResults, (image) =>
        this.pinterestService.createPin(
          accessToken,
          boardId,
          title,
          description,
          image.url,
          {
            link,
            mediaType: 'image',
            altText: pickAltText(metadata, [image]),
            aiModified: metadata?.aiModified === true,
            boardSectionId:
              typeof metadata?.boardSectionId === 'string'
                ? metadata.boardSectionId.trim() || undefined
                : undefined,
            dominantColor: pickDominantColor(metadata),
          },
        ),
      );
    }

    const result = await this.pinterestService.createPin(
      accessToken,
      boardId,
      title,
      description,
      mediaItems[0].url,
      {
        link,
        mediaType,
        videoCoverImageUrl: metadata?.videoCoverImageUrl,
        // A pin carries ONE alt text, and the composer writes alt text on
        // each media item rather than into the Pinterest panel — its row
        // is read-only and says "From each photo". So the pinned image's
        // own alt text is the real source; `metadata.altText` is only an
        // override for anything that still sets it that way.
        altText: pickAltText(metadata, mediaItems),
        aiModified: metadata?.aiModified === true,
        boardSectionId:
          typeof metadata?.boardSectionId === 'string'
            ? metadata.boardSectionId.trim() || undefined
            : undefined,
        extraImageUrls,
        dominantColor: pickDominantColor(metadata),
      },
    );

    this.logger.log(`Published to Pinterest: ${result.pinId}`);

    return {
      platformPostId: result.pinId,
      platformPostUrl: result.pinUrl,
    };
  }

  /**
   * Publishes each image as its own Pin, in order.
   *
   * The channel has ONE platformPostId, so it is the first image's Pin; every
   * Pin is in `itemResults`. An image already published by an earlier
   * attempt (same url in `previous`) is NOT published again - its Pin is
   * carried over. A failure part-way throws PartialPublishError carrying the
   * Pins that did go out, so the caller stores them and the retry resumes.
   */
  private async publishPinPerImage(
    images: MediaItem[],
    previous: PublishItemResult[] | undefined,
    createPin: (
      image: MediaItem,
    ) => Promise<{ pinId: string; pinUrl?: string }>,
  ): Promise<PublishResult> {
    const done = new Map(
      (previous ?? [])
        .filter((r) => r && typeof r.platformPostId === 'string')
        .map((r) => [r.mediaUrl, r]),
    );
    const results: PublishItemResult[] = [];

    for (const [i, image] of images.entries()) {
      const prior = done.get(image.url);
      if (prior) {
        results.push(prior);
        continue;
      }
      try {
        const pin = await createPin(image);
        results.push({
          mediaUrl: image.url,
          platformPostId: pin.pinId,
          ...(pin.pinUrl ? { platformPostUrl: pin.pinUrl } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Pinterest Pin ${i + 1} of ${images.length} failed after ${results.length} went out: ${reason}`,
        );
        // Nothing went out: the plain error, exactly as a single Pin fails.
        if (results.length === 0) throw err;
        throw new PartialPublishError(reason, results);
      }
    }

    this.logger.log(
      `Published ${results.length} Pins to Pinterest: ${results.map((r) => r.platformPostId).join(', ')}`,
    );
    return {
      platformPostId: results[0].platformPostId,
      platformPostUrl: results[0].platformPostUrl,
      itemResults: results,
    };
  }
}

/**
 * The alt text for the pin, or undefined.
 *
 * The composer stores alt text per media item (`DraftMediaItem.altText`,
 * set in the photo editor), not in the Pinterest panel — the panel's row
 * is read-only and reads "From each photo". A pin takes a single
 * `alt_text`, so the FIRST image's is the one that applies; on a carousel
 * the others have nowhere to go, since `multiple_image_urls` items carry
 * only a url.
 */
function pickAltText(
  metadata: Record<string, any> | undefined,
  mediaItems: MediaItem[],
): string | undefined {
  const fromPanel =
    typeof metadata?.altText === 'string' ? metadata.altText.trim() : '';
  if (fromPanel) return fromPanel;

  const fromMedia = mediaItems[0]?.altText;
  return typeof fromMedia === 'string' && fromMedia.trim()
    ? fromMedia.trim()
    : undefined;
}

/**
 * The Pin's `dominant_color`, as Pinterest writes one ("#6E7874"), or
 * undefined. Anything that is not a six-digit hex is not sent: an unknown
 * shape is one more field the create call could reject the Pin over.
 */
export function pickDominantColor(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const raw = metadata?.dominantColor;
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : undefined;
}

/**
 * Pick the pin description: prefer the dedicated Pinterest panel description
 * field (`metadata.description`) over the cross-platform body text
 * (`content`). Pinterest's "caption" is the description — body text from
 * other platforms shouldn't silently override what the user typed in the
 * Pinterest tab.
 */
function pickDescription(
  metadata: Record<string, unknown> | undefined,
  content: string | undefined,
): string {
  const fromPanel = metadata?.description;
  if (typeof fromPanel === 'string' && fromPanel.trim().length > 0) {
    return fromPanel;
  }
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }
  return '';
}

/**
 * Resolve the board ID from the composer metadata, accepting both the
 * canonical `boardId` field (frontend PinterestFields) and the legacy
 * `pinterestBoardId` name in case anything still emits it.
 */
function resolveBoardId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const fromCanonical = metadata.boardId;
  if (typeof fromCanonical === 'string' && fromCanonical.trim().length > 0) {
    return fromCanonical;
  }
  const fromLegacy = metadata.pinterestBoardId;
  if (typeof fromLegacy === 'string' && fromLegacy.trim().length > 0) {
    return fromLegacy;
  }
  return undefined;
}
