import { Module, forwardRef } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';

// Task 6 (webhook routing) made this circular: WebhooksController lives in
// InboxModule and now needs WhatsAppTemplatesService, so InboxModule imports
// this module (forwardRef'd on that side). InboxModule -> ChannelsModule is
// already forwardRef'd both ways, which means the ChannelsModule import
// below now sits on a real cycle (InboxModule -> WhatsAppTemplatesModule ->
// ChannelsModule -> ... -> InboxModule) and resolves to undefined at scan
// time without forwardRef here too. Same pattern as channels.module.ts's
// CalendarSyncModule import.
//
// WorkspaceRoleModule (not the full WorkspaceMembersModule) supplies
// WorkspaceRoleGuard's dependencies. Pulling in WorkspaceMembersModule here
// would drag in BillingModule and re-create the same
// NotificationsModule -> ChannelsModule -> WorkspaceMembers -> Billing ->
// NotificationsModule cycle that channels.module.ts documents avoiding.
@Module({
  imports: [forwardRef(() => ChannelsModule), WorkspaceRoleModule],
  controllers: [WhatsAppTemplatesController],
  providers: [WhatsAppTemplatesService],
  exports: [WhatsAppTemplatesService],
})
export class WhatsAppTemplatesModule {}
