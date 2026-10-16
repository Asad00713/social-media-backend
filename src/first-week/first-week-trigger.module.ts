import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '../queue/queue.module';
import { FirstWeekQueueService } from './first-week-queue.service';
import { FirstWeekRepository } from './first-week.repository';
import { FirstWeekTriggerService } from './first-week-trigger.service';

/**
 * The part of the first-week feature that AnalyticsModule needs: start a run
 * after a backfill. Deliberately a leaf (queue + the global Drizzle provider
 * only). The full FirstWeekModule needs ComposerModule -> ChannelsModule ->
 * AnalyticsModule, so AnalyticsModule importing the full module would cycle.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.FIRST_WEEK })],
  providers: [
    FirstWeekRepository,
    FirstWeekQueueService,
    FirstWeekTriggerService,
  ],
  exports: [
    FirstWeekRepository,
    FirstWeekQueueService,
    FirstWeekTriggerService,
  ],
})
export class FirstWeekTriggerModule {}
