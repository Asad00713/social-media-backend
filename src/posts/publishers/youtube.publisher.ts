import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { YouTubeService } from '../../channels/services/youtube.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

@Injectable()
export class YouTubePublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'youtube';

  constructor(private readonly youtubeService: YouTubeService) {
    super();
  }

  validate(options: PublishOptions): void {
    const { mediaItems, metadata } = options;

    // YouTube requires a video
    if (mediaItems.length === 0) {
      throw new Error('YouTube posts require a video');
    }

    if (mediaItems[0].type !== 'video') {
      throw new Error('YouTube only supports video content');
    }

    // Title is required for YouTube
    if (!metadata?.title) {
      throw new Error('YouTube videos require a title');
    }

    // Title max length is 100 characters
    if (metadata.title.length > 100) {
      throw new Error('YouTube title cannot exceed 100 characters');
    }

    // Description max length is 5000 characters
    if (options.content && options.content.length > 5000) {
      throw new Error('YouTube description cannot exceed 5000 characters');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    // YouTube only supports videos
    return mediaItems.every((m) => m.type === 'video');
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { content, mediaItems, accessToken, metadata } = options;

    this.validate(options);

    const result = await this.youtubeService.uploadVideoFromUrl(
      accessToken,
      mediaItems[0].url,
      {
        title: metadata.title,
        description: content || metadata.description || '',
        privacyStatus: metadata.privacyStatus || 'private',
        tags: metadata.tags || [],
        categoryId: metadata.categoryId || '22',
        playlistId: metadata.playlistId,
        madeForKids: metadata.madeForKids || false,
      },
    );

    this.logger.log(`Published to YouTube: ${result.videoId}`);

    return {
      platformPostId: result.videoId,
      platformPostUrl: result.videoUrl,
    };
  }
}
