import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelService } from './services/channel.service';
import { OAuthService } from './services/oauth.service';
import { FacebookService } from './services/facebook.service';
import { PinterestService } from './services/pinterest.service';
import { YouTubeService } from './services/youtube.service';
import { LinkedInService } from './services/linkedin.service';
import { TikTokService } from './services/tiktok.service';
import { TwitterService } from './services/twitter.service';
import { InstagramService } from './services/instagram.service';
import { ThreadsService } from './services/threads.service';
import { DrizzleModule } from '../drizzle/drizzle.module';

@Module({
  imports: [DrizzleModule],
  controllers: [ChannelsController],
  providers: [
    ChannelService,
    OAuthService,
    FacebookService,
    PinterestService,
    YouTubeService,
    LinkedInService,
    TikTokService,
    TwitterService,
    InstagramService,
    ThreadsService,
  ],
  exports: [
    ChannelService,
    OAuthService,
    FacebookService,
    PinterestService,
    YouTubeService,
    LinkedInService,
    TikTokService,
    TwitterService,
    InstagramService,
    ThreadsService,
  ],
})
export class ChannelsModule {}
