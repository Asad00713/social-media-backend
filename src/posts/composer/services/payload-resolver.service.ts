import { Injectable } from '@nestjs/common';
import type {
  Draft,
  ChannelTarget,
  PlatformOverride,
} from '../types/draft.types';
import type { PublicationPayload } from '../types/publication-payload.types';

/**
 * Resolves a Draft + ChannelTarget into the concrete payload that will
 * publish to that channel. Inheritance is sparse — fields not present
 * in perPlatform.<platform>.overrides inherit from draft.base.
 */
@Injectable()
export class PayloadResolverService {
  resolve(draft: Draft, channel: ChannelTarget): PublicationPayload {
    const override = draft.perPlatform[channel.platform] as
      | PlatformOverride<unknown>
      | undefined;
    const ov = override?.overrides ?? {};

    return {
      channelId: channel.channelId,
      platform: channel.platform,
      text: ov.text ?? draft.base.text,
      mediaItems: ov.mediaItems ?? draft.base.mediaItems,
      hashtags: ov.hashtags ?? draft.base.hashtags,
      mentions: ov.mentions ?? draft.base.mentions,
      linkPreview: ov.linkPreview ?? draft.base.linkPreview,
      platformSpecific: (override?.platformSpecific ?? {}) as Record<
        string,
        unknown
      >,
      scheduleAt: channel.scheduleAt ?? draft.schedule.scheduleAt,
    };
  }
}
