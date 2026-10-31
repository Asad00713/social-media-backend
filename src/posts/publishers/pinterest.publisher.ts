import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
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
    const { content, mediaItems, accessToken, metadata } = options;

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
    // The composer offers two modes for several images, and only this one
    // is real. "N separate Pins" would need the orchestrator to publish
    // once per image, and it publishes once per CHANNEL — so that mode is
    // still marked in the composer, and anything but an explicit carousel
    // keeps the old single-image behaviour rather than quietly becoming
    // one.
    const extraImageUrls =
      mediaType === 'image' && metadata?.asCarousel === true
        ? mediaItems
            .slice(1)
            .filter((m) => m.type === 'image')
            .map((m) => m.url)
        : [];

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
      },
    );

    this.logger.log(`Published to Pinterest: ${result.pinId}`);

    return {
      platformPostId: result.pinId,
      platformPostUrl: result.pinUrl,
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
