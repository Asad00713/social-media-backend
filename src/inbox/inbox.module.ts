import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InboxController } from './inbox.controller';
import { InboxAdminController } from './inbox-admin.controller';
import { WebhooksController } from '../channels/webhooks.controller';
import { InboxService } from './inbox.service';
import { InboxSettingsController } from './conversations/inbox-settings.controller';
import { InboxSettingsService } from './conversations/services/inbox-settings.service';
import { ConversationPresenter } from './conversations/services/conversation-presenter.service';
import { ConversationSyncService } from './conversations/services/conversation-sync.service';
import { InboxNotifyService } from './conversations/services/inbox-notify.service';
import { InboxRealtimeService } from './conversations/services/inbox-realtime.service';
import { InboxDispatcher } from './services/inbox-dispatcher.service';
import { BlueskyInboxAdapter } from './adapters/bluesky-inbox.adapter';
import { MastodonInboxAdapter } from './adapters/mastodon-inbox.adapter';
import { YoutubeInboxAdapter } from './adapters/youtube-inbox.adapter';
import { FacebookInboxAdapter } from './adapters/facebook-inbox.adapter';
import { InstagramInboxAdapter } from './adapters/instagram-inbox.adapter';
import { ThreadsInboxAdapter } from './adapters/threads-inbox.adapter';
import { FacebookDmAdapter } from './adapters/facebook-dm.adapter';
import { InstagramDmAdapter } from './adapters/instagram-dm.adapter';
import { BlueskyDmAdapter } from './adapters/bluesky-dm.adapter';
import { MastodonDmAdapter } from './adapters/mastodon-dm.adapter';
import { SlackDmAdapter } from './adapters/slack-dm.adapter';
import { TelegramDmAdapter } from './adapters/telegram-dm.adapter';
import { DiscordDmAdapter } from './adapters/discord-dm.adapter';
import { WhatsAppDmAdapter } from './adapters/whatsapp-dm.adapter';
import { WhatsAppService } from '../channels/services/whatsapp.service';
import { SlackIngestProcessor } from './processors/slack-ingest.processor';
import { TelegramIngestProcessor } from './processors/telegram-ingest.processor';
import { DiscordIngestProcessor } from './processors/discord-ingest.processor';
import { WhatsAppIngestProcessor } from './processors/whatsapp-ingest.processor';
import { WhatsAppIngestService } from './services/whatsapp-ingest.service';
import { InboxPollProcessor } from './processors/inbox-poll.processor';
import { InboxPollScheduler } from './schedulers/inbox-poll.scheduler';
import { ScheduledInboxProcessor } from './processors/scheduled-inbox.processor';
import { ScheduledMessagesService } from './services/scheduled-messages.service';
import { SlackBackfillService } from './services/slack-backfill.service';
import { YoutubeInboxBudgetService } from './services/youtube-inbox-budget.service';
import { YoutubeRetentionService } from './services/youtube-retention.service';
import { YoutubeRetentionScheduler } from './schedulers/youtube-retention.scheduler';
import { RedisClientProvider } from '../channels/analytics/redis-client.provider';
import { ChannelsModule } from '../channels/channels.module';
import { MediaModule } from '../media/media.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { WhatsAppTemplatesModule } from '../whatsapp-templates/whatsapp-templates.module';
import { QUEUES } from '../queue/queue.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../email/email.module';
import {
  CONVERSATION_API_CONTROLLERS,
  CONVERSATION_API_EXPORTS,
  CONVERSATION_API_PROVIDERS,
} from './conversations/conversation-api.providers';
import {
  MESSAGING_CONTROLLERS,
  MESSAGING_PROVIDERS,
} from './conversations/messaging.providers';

@Module({
  // ChannelsModule exposes platform services + ChannelService (token decrypt/refresh).
  // BullModule.registerQueue() is needed locally so this module can inject the
  // INBOX_POLLING queue token; the queue itself is configured once in QueueModule.
  imports: [
    WorkspaceRoleModule,
    // Bell + email notifications (InboxNotifyService). NotificationsModule is
    // global but imports ChannelsModule, which forwardRefs back here.
    forwardRef(() => NotificationsModule),
    EmailModule,
    forwardRef(() => ChannelsModule),
    MediaModule,
    // Circular by design: scheduled messages push to calendars
    // (CalendarPushSyncService) and calendars write back to scheduled messages
    // (CalendarPullSyncService → ScheduledMessagesService). Same shape as
    // PostsModule ↔ CalendarSyncModule.
    forwardRef(() => CalendarSyncModule),
    // WebhooksController (registered below) needs WhatsAppTemplatesService.
    // WhatsAppTemplatesModule imports ChannelsModule, which forwardRef's this
    // module back → forwardRef on this edge too, same pattern as ChannelsModule.
    forwardRef(() => WhatsAppTemplatesModule),
    BullModule.registerQueue(
      { name: QUEUES.INBOX_POLLING },
      { name: QUEUES.SCHEDULED_INBOX },
      { name: QUEUES.LEAD_INTAKE },
      { name: QUEUES.SLACK_INGEST },
      { name: QUEUES.TELEGRAM_INGEST },
      { name: QUEUES.DISCORD_INGEST },
      { name: QUEUES.WHATSAPP_INGEST },
      { name: QUEUES.MAESTRO_BRIDGE },
      { name: QUEUES.INBOX_LATER },
    ),
  ],
  controllers: [
    InboxController,
    InboxAdminController,
    InboxSettingsController,
    WebhooksController,
    ...CONVERSATION_API_CONTROLLERS,
    ...MESSAGING_CONTROLLERS,
  ],
  providers: [
    InboxService,
    InboxSettingsService,
    ConversationPresenter,
    ConversationSyncService,
    InboxRealtimeService,
    InboxNotifyService,
    InboxDispatcher,
    BlueskyInboxAdapter,
    MastodonInboxAdapter,
    YoutubeInboxAdapter,
    FacebookInboxAdapter,
    InstagramInboxAdapter,
    ThreadsInboxAdapter,
    FacebookDmAdapter,
    InstagramDmAdapter,
    BlueskyDmAdapter,
    MastodonDmAdapter,
    SlackDmAdapter,
    TelegramDmAdapter,
    DiscordDmAdapter,
    WhatsAppDmAdapter,
    WhatsAppService,
    SlackIngestProcessor,
    TelegramIngestProcessor,
    DiscordIngestProcessor,
    WhatsAppIngestService,
    WhatsAppIngestProcessor,
    InboxPollProcessor,
    InboxPollScheduler,
    ScheduledMessagesService,
    ScheduledInboxProcessor,
    SlackBackfillService,
    YoutubeInboxBudgetService,
    YoutubeRetentionService,
    YoutubeRetentionScheduler,
    RedisClientProvider,
    ...CONVERSATION_API_PROVIDERS,
    ...MESSAGING_PROVIDERS,
  ],
  exports: [
    InboxService,
    ConversationSyncService,
    InboxNotifyService,
    InboxDispatcher,
    ScheduledMessagesService,
    SlackBackfillService,
    ...CONVERSATION_API_EXPORTS,
  ],
})
export class InboxModule {}
