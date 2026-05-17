import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { WebhooksController } from './webhooks.controller';
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
import { BlueskyService } from './services/bluesky.service';
import { MastodonService } from './services/mastodon.service';
import { GoogleDriveService } from './services/google-drive.service';
import { GooglePhotosService } from './services/google-photos.service';
import { GoogleCalendarService } from './services/google-calendar.service';
import { OneDriveService } from './services/onedrive.service';
import { DropboxService } from './services/dropbox.service';
import { UnsplashService } from './services/unsplash.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { QueueModule } from '../queue/queue.module';
import { TokenRefreshProcessor } from './processors/token-refresh.processor';
import { TokenRefreshScheduler } from './schedulers/token-refresh.scheduler';
import { RefreshTokenExpiryScheduler } from './schedulers/refresh-token-expiry.scheduler';

@Module({
  imports: [DrizzleModule, AnalyticsModule, QueueModule],
  controllers: [ChannelsController, WebhooksController],
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
    BlueskyService,
    MastodonService,
    GoogleDriveService,
    GooglePhotosService,
    GoogleCalendarService,
    OneDriveService,
    DropboxService,
    UnsplashService,
    TokenRefreshProcessor,
    TokenRefreshScheduler,
    RefreshTokenExpiryScheduler,
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
    BlueskyService,
    MastodonService,
    GoogleDriveService,
    GooglePhotosService,
    GoogleCalendarService,
    OneDriveService,
    DropboxService,
    UnsplashService,
  ],
})
export class ChannelsModule {}
