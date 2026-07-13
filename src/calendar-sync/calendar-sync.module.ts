import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelsModule } from '../channels/channels.module';
import { PostsModule } from '../posts/posts.module';
import {
  CALENDAR_RECONCILE_QUEUE,
  CALENDAR_RENEWAL_QUEUE,
} from './calendar-sync.constants';
import { CalendarSyncController } from './calendar-sync.controller';
import { CalendarWebhookController } from './calendar-webhook.controller';
import { CalendarSyncScheduler } from './calendar-sync.scheduler';
import { CalendarPushSyncService } from './services/calendar-push-sync.service';
import { CalendarPullSyncService } from './services/calendar-pull-sync.service';
import { CalendarSubscriptionService } from './services/calendar-subscription.service';
import { ExternalEventsService } from './services/external-events.service';
import { CalendarReconcileProcessor } from './processors/calendar-reconcile.processor';
import { CalendarRenewalProcessor } from './processors/calendar-renewal.processor';

// CalendarSyncModule — app<->calendar two-way sync.
// Task A wired the schema + BullMQ queues. Task B adds the app→calendar push
// service (reusing ChannelsModule's Google/Outlook calendar services +
// ChannelService token accessor) + a backfill endpoint. The queues are
// configured centrally by QueueModule's BullModule.forRootAsync; registering
// them here just exposes the queue tokens for injection within this module.
// DrizzleModule is @Global, so the DRIZZLE provider is available without import.
// CalendarPushSyncService is exported so PostsModule can call it from the post
// lifecycle paths.
// Task C adds the calendar→app PULL half: CalendarPullSyncService (delta import
// of the user's OTHER events + cursor management) and ExternalEventsService
// (read side for the calendar UI, exposed at
// GET /calendar-sync/workspaces/:workspaceId/external-events).
// Task D adds the two-way half to the pull service: it applies external
// moves/deletes back onto the post via PostService's EXISTING reschedule /
// unschedule paths. PostsModule already imports CalendarSyncModule for the push
// service, so the pair is circular by design → forwardRef on both sides.
// Task E gives the pull service its TRIGGERS: provider push subscriptions
// (CalendarSubscriptionService) + the public webhook controller they call back
// on, the BullMQ processors that run reconcile/renewal, and the scheduler that
// polls every 15 min as the safety net. ChannelsController subscribes on connect
// and tears down on disconnect, so ChannelsModule ↔ CalendarSyncModule is now
// circular too → forwardRef on both sides.
@Module({
  imports: [
    forwardRef(() => ChannelsModule),
    forwardRef(() => PostsModule),
    BullModule.registerQueue(
      { name: CALENDAR_RECONCILE_QUEUE },
      { name: CALENDAR_RENEWAL_QUEUE },
    ),
  ],
  controllers: [CalendarSyncController, CalendarWebhookController],
  providers: [
    CalendarPushSyncService,
    CalendarPullSyncService,
    CalendarSubscriptionService,
    ExternalEventsService,
    CalendarReconcileProcessor,
    CalendarRenewalProcessor,
    CalendarSyncScheduler,
  ],
  exports: [
    CalendarPushSyncService,
    CalendarPullSyncService,
    CalendarSubscriptionService,
    ExternalEventsService,
  ],
})
export class CalendarSyncModule {}
