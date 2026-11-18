import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from 'src/auth/auth.module';
import { BillingModule } from 'src/billing/billing.module';
import { UsersModule } from 'src/users/users.module';
import { LibrarySamplesModule } from 'src/media-library/samples/library-samples.module';
import { WorkspaceRoleModule } from 'src/workspace-members/workspace-role.module';
import { MediaModule } from 'src/media/media.module';
import { PostsModule } from 'src/posts/posts.module';
import { QueueModule } from 'src/queue/queue.module';
import { WorkspaceTimezoneMoveService } from './workspace-timezone-move.service';
import { WorkspaceTimezoneMoveProcessor } from './workspace-timezone-move.processor';

@Module({
  imports: [
    PassportModule,
    AuthModule,
    JwtModule.register({}),
    BillingModule,
    UsersModule,
    LibrarySamplesModule,
    // WorkspaceRoleGuard on the General routes.
    WorkspaceRoleModule,
    // R2: the logo presign and the own-URL check on `logo`.
    MediaModule,
    // The time-zone move: PostRescheduleService and its own queue.
    PostsModule,
    QueueModule,
  ],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceTimezoneMoveService,
    WorkspaceTimezoneMoveProcessor,
  ],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
