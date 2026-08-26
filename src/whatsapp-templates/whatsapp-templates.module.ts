import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';

// ChannelsModule does not import this module back, so no forwardRef is
// needed here (unlike CalendarSyncModule <-> ChannelsModule). If Task 5's
// controller work introduces a back-reference, wrap this in forwardRef(() =>
// ChannelsModule) the way channels.module.ts does for CalendarSyncModule.
//
// WorkspaceRoleModule (not the full WorkspaceMembersModule) supplies
// WorkspaceRoleGuard's dependencies. Pulling in WorkspaceMembersModule here
// would drag in BillingModule and re-create the same
// NotificationsModule -> ChannelsModule -> WorkspaceMembers -> Billing ->
// NotificationsModule cycle that channels.module.ts documents avoiding.
@Module({
  imports: [ChannelsModule, WorkspaceRoleModule],
  controllers: [WhatsAppTemplatesController],
  providers: [WhatsAppTemplatesService],
  exports: [WhatsAppTemplatesService],
})
export class WhatsAppTemplatesModule {}
