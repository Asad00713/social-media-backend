import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InboxController } from './inbox.controller';
import { WebhooksController } from '../channels/webhooks.controller';
import { InboxService } from './inbox.service';
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
import { InboxPollProcessor } from './processors/inbox-poll.processor';
import { InboxPollScheduler } from './schedulers/inbox-poll.scheduler';
import { ScheduledInboxProcessor } from './processors/scheduled-inbox.processor';
import { ScheduledMessagesService } from './services/scheduled-messages.service';
import { ChannelsModule } from '../channels/channels.module';
import { MediaModule } from '../media/media.module';
import { QUEUES } from '../queue/queue.module';

@Module({
  // ChannelsModule exposes platform services + ChannelService (token decrypt/refresh).
  // BullModule.registerQueue() is needed locally so this module can inject the
  // INBOX_POLLING queue token; the queue itself is configured once in QueueModule.
  imports: [
    ChannelsModule,
    MediaModule,
    BullModule.registerQueue(
      { name: QUEUES.INBOX_POLLING },
      { name: QUEUES.SCHEDULED_INBOX },
      { name: QUEUES.LEAD_INTAKE },
    ),
  ],
  controllers: [InboxController, WebhooksController],
  providers: [
    InboxService,
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
    InboxPollProcessor,
    InboxPollScheduler,
    ScheduledMessagesService,
    ScheduledInboxProcessor,
  ],
  exports: [InboxService, InboxDispatcher, ScheduledMessagesService],
})
export class InboxModule {}
