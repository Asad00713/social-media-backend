import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostsModule } from '../posts/posts.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PlannerController } from './planner.controller';
import { PlannerNotesController } from './planner-notes.controller';
import { PlannerPreferencesController } from './planner-preferences.controller';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';
import { PlannerNotesService } from './services/planner-notes.service';
import { PlannerPreferencesService } from './services/planner-preferences.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule, PostsModule],
  controllers: [
    PlannerController,
    PlannerNotesController,
    PlannerPreferencesController,
  ],
  providers: [
    PlannerListService,
    PlannerLookupService,
    PlannerNotesService,
    PlannerPreferencesService,
  ],
})
export class PlannerModule {}
