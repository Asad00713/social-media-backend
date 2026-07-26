import { Module } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceRoleModule } from './workspace-role.module';
import { WorkspaceMembersController } from './workspace-members.controller';
import { PublicInvitationsController } from './public-invitations.controller';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from 'src/auth/auth.module';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from 'src/billing/billing.module';
import { EmailModule } from 'src/email/email.module';

@Module({
  imports: [
    PassportModule,
    AuthModule,
    JwtModule.register({}),
    BillingModule,
    EmailModule,
    WorkspaceRoleModule,
  ],
  providers: [WorkspaceMembersService],
  controllers: [WorkspaceMembersController, PublicInvitationsController],
  // Re-export the role module so existing consumers of WorkspaceMembersModule
  // keep receiving WorkspaceRoleService / WorkspaceRoleGuard.
  exports: [WorkspaceRoleModule],
})
export class WorkspaceMembersModule {}
