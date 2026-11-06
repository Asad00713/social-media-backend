import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PostCommentsController } from './post-comments.controller';
import { PostCommentsService } from './post-comments.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [PostCommentsController],
  providers: [PostCommentsService],
})
export class PostCommentsModule {}
