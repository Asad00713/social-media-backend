import { Logger } from '@nestjs/common';
import {
  MediaItem,
  PublishItemResult,
} from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface PublishResult {
  platformPostId: string;
  platformPostUrl?: string;
  metadata?: Record<string, any>;
  /**
   * Set by a publisher that sent the post as several platform posts (one Pin
   * per image). `platformPostId` is then the FIRST item's id. Callers store
   * this on the channel target and hand it back as `previousItemResults`.
   */
  itemResults?: PublishItemResult[];
}

/**
 * A publish that failed part-way through a multi-item post. The items in
 * `itemResults` ARE live on the platform: callers must store them on the
 * target (failed) so a retry skips them instead of posting them twice.
 * The message is the underlying failure's, so error classification is
 * unchanged.
 */
export class PartialPublishError extends Error {
  constructor(
    message: string,
    readonly itemResults: PublishItemResult[],
  ) {
    super(message);
    this.name = 'PartialPublishError';
  }
}

export interface PublishOptions {
  content: string;
  mediaItems: MediaItem[];
  metadata: Record<string, any>;
  accessToken: string;
  platformAccountId: string;
  channelMetadata: Record<string, any>;
  /**
   * Internal DB channel id (numeric, not the platform account id). Most
   * publishers ignore it; YouTubePublisher uses it to key its pre-audit /
   * per-channel upload caps (see YoutubeAuditGateService). Required so every
   * caller supplies a real id rather than the gate silently keying off
   * `undefined`.
   */
  channelId: number;
  /**
   * What an earlier attempt at this same target already published, item by
   * item. A publisher that sends several items skips these on a retry.
   */
  previousItemResults?: PublishItemResult[];
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
