import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelsModule } from '../channels/channels.module';
import {
  CALENDAR_RECONCILE_QUEUE,
  CALENDAR_RENEWAL_QUEUE,
} from './calendar-sync.constants';
import { CalendarSyncController } from './calendar-sync.controller';
import { CalendarPushSyncService } from './services/calendar-push-sync.service';

// CalendarSyncModule — app<->calendar two-way sync.
// Task A wired the schema + BullMQ queues. Task B adds the app→calendar push
// service (reusing ChannelsModule's Google/Outlook calendar services +
// ChannelService token accessor) + a backfill endpoint. The queues are
// configured centrally by QueueModule's BullModule.forRootAsync; registering
// them here just exposes the queue tokens for injection within this module.
// DrizzleModule is @Global, so the DRIZZLE provider is available without import.
// CalendarPushSyncService is exported so PostsModule can call it from the post
// lifecycle paths.
@Module({
  imports: [
    ChannelsModule,
    BullModule.registerQueue(
      { name: CALENDAR_RECONCILE_QUEUE },
      { name: CALENDAR_RENEWAL_QUEUE },
    ),
  ],
  controllers: [CalendarSyncController],
  providers: [CalendarPushSyncService],
  exports: [CalendarPushSyncService],
})
export class CalendarSyncModule {}
