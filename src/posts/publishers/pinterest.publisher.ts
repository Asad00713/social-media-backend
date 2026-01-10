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

    // Pinterest requires a board ID
    if (!metadata?.pinterestBoardId) {
      throw new Error('Pinterest board ID is required');
    }

    // Check media type
    const mediaType = mediaItems[0].type;
    if (mediaType !== 'image' && mediaType !== 'video') {
      throw new Error('Pinterest pins only support images and videos');
    }

    // Check title length (max 100 chars)
    if (metadata?.title && metadata.title.length > 100) {
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

    const boardId = metadata.pinterestBoardId;
    const title = metadata?.title || content?.slice(0, 100) || 'Pin';
    const link = metadata?.link;
    const mediaType = mediaItems[0].type as 'image' | 'video';

    const result = await this.pinterestService.createPin(
      accessToken,
      boardId,
      title,
      content || '',
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
