import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { PostsModule } from '../posts/posts.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PlannerBestTimesController } from './planner-best-times.controller';
import { PlannerController } from './planner.controller';
import { PlannerNotesController } from './planner-notes.controller';
import { PlannerPreferencesController } from './planner-preferences.controller';
import { BestTimesService } from './services/best-times.service';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';
import { PlannerNotesService } from './services/planner-notes.service';
import { PlannerPreferencesService } from './services/planner-preferences.service';

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
  ],
  providers: [
    BestTimesService,
    PlannerListService,
    PlannerLookupService,
    PlannerNotesService,
    PlannerPreferencesService,
  ],
})
export class PlannerModule {}
