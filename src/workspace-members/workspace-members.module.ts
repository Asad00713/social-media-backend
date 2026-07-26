import { Module } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceRoleService } from './workspace-role.service';
import { WorkspaceRoleGuard } from './workspace-role.guard';
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
  ],
  providers: [WorkspaceMembersService, WorkspaceRoleService, WorkspaceRoleGuard],
  controllers: [WorkspaceMembersController, PublicInvitationsController],
  exports: [WorkspaceRoleService, WorkspaceRoleGuard],
})
export class WorkspaceMembersModule {}
