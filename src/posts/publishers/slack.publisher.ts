import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { SlackService } from '../../channels/services/slack.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface Destination {
  id: string;
  name?: string;
}

/**
 * Slack publisher — sends a single message (text and/or one media) to a chosen
 * Slack channel. The destination channel id comes from
 * `metadata.destination.id` (set by the campaign composer's destination
 * picker, threaded through PostTarget.destination). Uses the per-channel bot
 * token (`chat:write.public` lets it post to public channels without joining).
 */
@Injectable()
export class SlackPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'slack';

  constructor(private readonly slackService: SlackService) {
    super();
  }

  private destination(options: PublishOptions): Destination | undefined {
    return options.metadata?.destination as Destination | undefined;
  }

  validate(options: PublishOptions): void {
    const dest = this.destination(options);
    if (!dest?.id) {
      throw new Error('Slack message requires a destination channel');
    }
    if (options.mediaItems.length > 1) {
      throw new Error('Slack message supports at most one media item');
    }
    const hasText = (options.content ?? '').trim().length > 0;
    if (!hasText && options.mediaItems.length === 0) {
      throw new Error('Slack message requires a message or media');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.length <= 1;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    this.validate(options);
    const dest = this.destination(options) as Destination;
    const { content, mediaItems, accessToken } = options;

    if (mediaItems.length === 0) {
      const res = await this.slackService.postMessage(accessToken, {
        channel: dest.id,
        text: content ?? '',
      });
      this.logger.log(`Posted Slack message to ${dest.id}: ${res.ts}`);
      return { platformPostId: res.ts };
    }

    const media = mediaItems[0];
    const resp = await fetch(media.url);
    if (!resp.ok) {
      throw new Error(`Failed to download Slack media (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    const filename = media.url.split('/').pop()?.split('?')[0] || 'attachment';

    const res = await this.slackService.uploadFile(accessToken, {
      channelId: dest.id,
      filename,
      contentType,
      buffer,
      initialComment: content || undefined,
    });
    this.logger.log(`Uploaded Slack file to ${dest.id}: ${res.fileId}`);
    return { platformPostId: res.fileId };
  }
}
