import { Module } from '@nestjs/common';
import { WorkspaceRoleService } from './workspace-role.service';
import { WorkspaceRoleGuard } from './workspace-role.guard';

/**
 * Lightweight module exposing workspace role resolution + the capability guard.
 *
 * Deliberately depends on NOTHING but the (global) Drizzle provider and the
 * (global) Reflector, so feature modules that only need to *gate* routes
 * (e.g. ChannelsModule) can import this without dragging in the full
 * WorkspaceMembersModule — which pulls BillingModule and would close the
 * NotificationsModule → ChannelsModule → WorkspaceMembers → Billing →
 * NotificationsModule circular-dependency loop.
 */
@Module({
  providers: [WorkspaceRoleService, WorkspaceRoleGuard],
  exports: [WorkspaceRoleService, WorkspaceRoleGuard],
})
export class WorkspaceRoleModule {}
