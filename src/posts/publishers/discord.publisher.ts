import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { DiscordService } from '../../channels/services/discord.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface Destination {
  id: string;
  name?: string;
}

/**
 * Discord publisher — sends a single message (text and/or one media) to a
 * chosen guild text channel. Destination channel id comes from
 * `metadata.destination.id`. Uses the shared env DISCORD_BOT_TOKEN baked into
 * DiscordService (ignores `options.accessToken`, unlike per-channel-token
 * platforms).
 */
@Injectable()
export class DiscordPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'discord';

  constructor(private readonly discordService: DiscordService) {
    super();
  }

  private destination(options: PublishOptions): Destination | undefined {
    return options.metadata?.destination as Destination | undefined;
  }

  validate(options: PublishOptions): void {
    const dest = this.destination(options);
    if (!dest?.id) {
      throw new Error('Discord message requires a destination channel');
    }
    if (options.mediaItems.length > 1) {
      throw new Error('Discord message supports at most one media item');
    }
    const hasText = (options.content ?? '').trim().length > 0;
    if (!hasText && options.mediaItems.length === 0) {
      throw new Error('Discord message requires a message or media');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.length <= 1;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    this.validate(options);
    const dest = this.destination(options) as Destination;
    const { content, mediaItems } = options;

    let files: { name: string; data: Buffer; contentType?: string }[] | undefined;
    if (mediaItems.length === 1) {
      const media = mediaItems[0];
      const resp = await fetch(media.url);
      if (!resp.ok) {
        throw new Error(`Failed to download Discord media (${resp.status})`);
      }
      const data = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get('content-type') ?? undefined;
      const name = media.url.split('/').pop()?.split('?')[0] || 'attachment';
      files = [{ name, data, contentType }];
    }

    const res = await this.discordService.createMessage(dest.id, {
      content: content || undefined,
      files,
    });
    this.logger.log(`Posted Discord message to ${dest.id}: ${res.id}`);
    return { platformPostId: res.id };
  }
}
