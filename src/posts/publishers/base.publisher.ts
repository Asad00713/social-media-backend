import { Logger } from '@nestjs/common';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface PublishResult {
  platformPostId: string;
  platformPostUrl?: string;
  metadata?: Record<string, any>;
}

export interface PublishOptions {
  content: string;
  mediaItems: MediaItem[];
  metadata: Record<string, any>;
  accessToken: string;
  platformAccountId: string;
  channelMetadata: Record<string, any>;
}

export abstract class BasePublisher {
  protected readonly logger: Logger;
  abstract readonly platform: SupportedPlatform;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  abstract publish(options: PublishOptions): Promise<PublishResult>;

  /**
   * Validate the content before publishing
   */
  abstract validate(options: PublishOptions): void;

  /**
   * Check if this publisher supports the given media types
   */
  abstract supportsMediaTypes(mediaItems: MediaItem[]): boolean;
}
