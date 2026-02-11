import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './services/community.service';
import { CommunityProviderFactory } from './providers/community-provider.factory';
import { TwitterCommunityProvider } from './providers/twitter-community.provider';
import { ThreadsCommunityProvider } from './providers/threads-community.provider';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  imports: [ChannelsModule],
  controllers: [CommunityController],
  providers: [
    CommunityService,
    CommunityProviderFactory,
    TwitterCommunityProvider,
    ThreadsCommunityProvider,
  ],
  exports: [CommunityService],
})
export class CommunityModule {}
