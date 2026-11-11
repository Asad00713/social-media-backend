import { BadRequestException, Injectable } from '@nestjs/common';
import { ChannelService } from '../../../channels/services/channel.service';
import type { ChannelCredentialsLookup } from './publish-orchestrator.service';
import {
  isRealChannelId,
  REAL_CHANNEL_ID_MESSAGE,
} from '../dto/real-channel-ids.validator';

@Injectable()
export class ChannelCredentialsAdapter implements ChannelCredentialsLookup {
  constructor(private readonly channelService: ChannelService) {}

  async getCredentials(workspaceId: string, channelId: string) {
    // Not `Number.isFinite`: `Number('')` is 0, which passed and was looked
    // up as channel 0.
    if (!isRealChannelId(channelId)) {
      throw new BadRequestException(
        `${REAL_CHANNEL_ID_MESSAGE} (got ${JSON.stringify(channelId)})`,
      );
    }
    const numericId = Number(channelId);
    const channel = await this.channelService.getChannelById(
      numericId,
      workspaceId,
    );
    const accessToken = await this.channelService.getAccessToken(
      numericId,
      workspaceId,
    );
    return {
      accessToken,
      platformAccountId: channel.platformAccountId,
      channelMetadata: channel.metadata ?? {},
    };
  }
}
