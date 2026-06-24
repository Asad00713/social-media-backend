import { BadRequestException, Injectable } from '@nestjs/common';
import { ChannelService } from '../../../channels/services/channel.service';
import type { ChannelCredentialsLookup } from './publish-orchestrator.service';

@Injectable()
export class ChannelCredentialsAdapter implements ChannelCredentialsLookup {
  constructor(private readonly channelService: ChannelService) {}

  async getCredentials(workspaceId: string, channelId: string) {
    const numericId = Number(channelId);
    if (!Number.isFinite(numericId)) {
      throw new BadRequestException(`Invalid channelId: ${channelId}`);
    }
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
