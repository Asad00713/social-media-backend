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
