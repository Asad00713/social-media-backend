import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostsModule } from '../posts/posts.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PlannerController } from './planner.controller';
import { PlannerNotesController } from './planner-notes.controller';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';
import { PlannerNotesService } from './services/planner-notes.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule, PostsModule],
  controllers: [PlannerController, PlannerNotesController],
  providers: [PlannerListService, PlannerLookupService, PlannerNotesService],
})
export class PlannerModule {}
