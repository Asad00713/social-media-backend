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
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
