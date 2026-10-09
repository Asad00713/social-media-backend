import { Module } from '@nestjs/common';
import { WorkspaceHubController } from './workspace-hub.controller';
import { WorkspaceHubService } from './workspace-hub.service';

@Module({
  controllers: [WorkspaceHubController],
  providers: [WorkspaceHubService],
})
export class WorkspaceHubModule {}
