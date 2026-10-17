import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostsModule } from '../posts/posts.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PlannerController } from './planner.controller';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule, PostsModule],
  controllers: [PlannerController],
  providers: [PlannerListService, PlannerLookupService],
})
export class PlannerModule {}
