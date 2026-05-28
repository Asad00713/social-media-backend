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
import { BlueskyService } from './services/bluesky.service';
import { MastodonService } from './services/mastodon.service';
import { GoogleDriveService } from './services/google-drive.service';
import { GooglePhotosService } from './services/google-photos.service';
import { GoogleCalendarService } from './services/google-calendar.service';
import { OneDriveService } from './services/onedrive.service';
import { DropboxService } from './services/dropbox.service';
import { UnsplashService } from './services/unsplash.service';
import { RedditService } from './services/reddit.service';
import { MetaAdsClient } from '../ads/services/meta-ads.client';
import { AdAccountsService } from '../ads/services/ad-accounts.service';
import { BoostPostService } from '../ads/services/boost-post.service';
import { LeadFormService } from '../ads/services/lead-form.service';
import { LeadCampaignService } from '../ads/services/lead-campaign.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { QueueModule } from '../queue/queue.module';
import { TokenRefreshProcessor } from './processors/token-refresh.processor';
import { TokenRefreshScheduler } from './schedulers/token-refresh.scheduler';
import { RefreshTokenExpiryScheduler } from './schedulers/refresh-token-expiry.scheduler';

@Module({
  imports: [DrizzleModule, AnalyticsModule, QueueModule],
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
    BlueskyService,
    MastodonService,
    GoogleDriveService,
    GooglePhotosService,
    GoogleCalendarService,
    OneDriveService,
    DropboxService,
    UnsplashService,
    RedditService,
    TokenRefreshProcessor,
    TokenRefreshScheduler,
    RefreshTokenExpiryScheduler,
    MetaAdsClient,
    AdAccountsService,
    BoostPostService,
    LeadFormService,
    LeadCampaignService,
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
    RedditService,
    MetaAdsClient,
    AdAccountsService,
    BoostPostService,
    LeadFormService,
    LeadCampaignService,
  ],
})
export class ChannelsModule {}
