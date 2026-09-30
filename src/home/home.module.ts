import { Module } from '@nestjs/common';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing — see whatsapp-templates.module.ts.
@Module({
  imports: [WorkspaceRoleModule, PostPerformanceModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
