import { Module } from '@nestjs/common';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing; see home.module.ts.
@Module({
  imports: [WorkspaceRoleModule, PostPerformanceModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
