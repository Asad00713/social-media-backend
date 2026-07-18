import { Module, forwardRef } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelService } from './services/channel.service';
import { OAuthService } from './services/oauth.service';
import { FacebookService } from './services/facebook.service';
import { PinterestService } from './services/pinterest.service';
import { YouTubeService } from './services/youtube.service';
import { LinkedInService } from './services/linkedin.service';
import { TikTokService } from './services/tiktok.service';
import { TikTokQuotaService } from './services/tiktok-quota.service';
import { YoutubeAuditGateService } from './services/youtube-audit-gate.service';
import { RedisClientProvider } from './analytics/redis-client.provider';
import { TwitterService } from './services/twitter.service';
import { InstagramService } from './services/instagram.service';
import { ThreadsService } from './services/threads.service';
import { BlueskyService } from './services/bluesky.service';
import { MastodonService } from './services/mastodon.service';
import { GoogleOauthRevokeService } from './services/google-oauth-revoke.service';
import { YoutubeDataDeletionService } from './services/youtube-data-deletion.service';
import { GoogleDriveService } from './services/google-drive.service';
import { GooglePhotosService } from './services/google-photos.service';
import { GoogleCalendarService } from './services/google-calendar.service';
import { OutlookCalendarService } from './services/outlook-calendar.service';
import { OneDriveService } from './services/onedrive.service';
import { DropboxService } from './services/dropbox.service';
import { UnsplashService } from './services/unsplash.service';
import { RedditService } from './services/reddit.service';
import { SlackService } from './services/slack.service';
import { TelegramService } from './services/telegram.service';
import { DiscordService } from './services/discord.service';
import { DiscordGatewayService } from './services/discord-gateway.service';
import { TelegramConnectService } from './services/telegram-connect.service';
import { WhatsAppService } from './services/whatsapp.service';
import { WhatsAppOnboardingService } from './services/whatsapp-onboarding.service';
import { MetaAdsClient } from '../ads/services/meta-ads.client';
import { AdAccountsService } from '../ads/services/ad-accounts.service';
import { BoostPostService } from '../ads/services/boost-post.service';
import { LeadFormService } from '../ads/services/lead-form.service';
import { LeadCampaignService } from '../ads/services/lead-campaign.service';
import { LeadIntakeService } from '../ads/services/lead-intake.service';
import { LeadIntakeProcessor } from '../ads/processors/lead-intake.processor';
import { InboxModule } from '../inbox/inbox.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { QueueModule } from '../queue/queue.module';
import { BullModule } from '@nestjs/bullmq';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { CALENDAR_RECONCILE_QUEUE } from '../calendar-sync/calendar-sync.constants';
import { TokenRefreshProcessor } from './processors/token-refresh.processor';
import { TokenRefreshScheduler } from './schedulers/token-refresh.scheduler';
import { RefreshTokenExpiryScheduler } from './schedulers/refresh-token-expiry.scheduler';
import { YoutubeAuthorizationCheckScheduler } from './schedulers/youtube-authorization-check.scheduler';

// CalendarSyncModule is imported (forwardRef — CalendarSyncModule imports this
// one back) so the OAuth callback can arm the provider push subscription the
// moment a calendar is connected, and the disconnect path can tear it down
// before the token is deleted. The reconcile queue is registered here too so the
// callback can kick an immediate first sync.
@Module({
  imports: [
    DrizzleModule,
    AnalyticsModule,
    QueueModule,
    forwardRef(() => InboxModule),
    forwardRef(() => CalendarSyncModule),
    BullModule.registerQueue({ name: CALENDAR_RECONCILE_QUEUE }),
  ],
  controllers: [ChannelsController],
  providers: [
    ChannelService,
    OAuthService,
    FacebookService,
    PinterestService,
    YouTubeService,
    LinkedInService,
    TikTokService,
    TikTokQuotaService,
    YoutubeAuditGateService,
    RedisClientProvider,
    TwitterService,
    InstagramService,
    ThreadsService,
    BlueskyService,
    MastodonService,
    GoogleOauthRevokeService,
    YoutubeDataDeletionService,
    GoogleDriveService,
    GooglePhotosService,
    GoogleCalendarService,
    OutlookCalendarService,
    OneDriveService,
    DropboxService,
    UnsplashService,
    RedditService,
    SlackService,
    TelegramService,
    TelegramConnectService,
    WhatsAppService,
    WhatsAppOnboardingService,
    DiscordService,
    DiscordGatewayService,
    TokenRefreshProcessor,
    TokenRefreshScheduler,
    RefreshTokenExpiryScheduler,
    YoutubeAuthorizationCheckScheduler,
    MetaAdsClient,
    AdAccountsService,
    BoostPostService,
    LeadFormService,
    LeadCampaignService,
    LeadIntakeService,
    LeadIntakeProcessor,
  ],
  exports: [
    ChannelService,
    OAuthService,
    FacebookService,
    PinterestService,
    YouTubeService,
    LinkedInService,
    TikTokService,
    TikTokQuotaService,
    YoutubeAuditGateService,
    TwitterService,
    InstagramService,
    ThreadsService,
    BlueskyService,
    MastodonService,
    GoogleOauthRevokeService,
    GoogleDriveService,
    GooglePhotosService,
    GoogleCalendarService,
    OutlookCalendarService,
    OneDriveService,
    DropboxService,
    UnsplashService,
    RedditService,
    SlackService,
    TelegramService,
    DiscordService,
    MetaAdsClient,
    AdAccountsService,
    BoostPostService,
    LeadFormService,
    LeadCampaignService,
    LeadIntakeService,
  ],
})
export class ChannelsModule {}
