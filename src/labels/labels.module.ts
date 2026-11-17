import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { PostLabelsService } from './post-labels.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [LabelsController],
  providers: [LabelsService, PostLabelsService],
  exports: [LabelsService, PostLabelsService],
})
export class LabelsModule {}
