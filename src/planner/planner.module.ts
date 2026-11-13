import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { PostsModule } from '../posts/posts.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PlannerBestTimesController } from './planner-best-times.controller';
import { PlannerController } from './planner.controller';
import { PlannerNotesController } from './planner-notes.controller';
import { PlannerPreferencesController } from './planner-preferences.controller';
import { PlannerQueueController } from './planner-queue.controller';
import { BestTimesService } from './services/best-times.service';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';
import { PlannerNotesService } from './services/planner-notes.service';
import { PlannerPreferencesService } from './services/planner-preferences.service';
import { QueueSlotsService } from './services/queue-slots.service';

@Module({
  imports: [
    DrizzleModule,
    WorkspaceRoleModule,
    PostsModule,
    PostPerformanceModule,
  ],
  controllers: [
    PlannerController,
    PlannerBestTimesController,
    PlannerNotesController,
    PlannerPreferencesController,
    PlannerQueueController,
  ],
  providers: [
    BestTimesService,
    PlannerListService,
    PlannerLookupService,
    PlannerNotesService,
    PlannerPreferencesService,
    QueueSlotsService,
  ],
  // The channel page reads one channel's best times.
  exports: [BestTimesService],
})
export class PlannerModule {}
