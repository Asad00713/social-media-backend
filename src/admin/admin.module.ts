import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminActivityService } from './admin-activity.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditRetentionService } from './admin-audit-retention.service';
import { AdminLogsService } from './admin-logs.service';
import { UserInactivityService } from './user-inactivity.service';
import { QueueMonitorService } from './queue-monitor.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { EmailModule } from '../email/email.module';
import { QueueModule } from '../queue/queue.module';
import { ChannelsModule } from '../channels/channels.module';
import { WorkspaceMembersModule } from '../workspace-members/workspace-members.module';
import { SecurityCoreModule } from '../auth/security-core.module';
import { TwoFactorNotices } from '../auth/two-factor/two-factor-notices.service';
import { GeoipService } from '../auth/services/geoip.service';

@Module({
  // Channels and members are imported for their services rather than
  // reimplemented here. Disconnecting a channel cancels its sync jobs,
  // revokes the Google grant while the token still exists, and decrements the
  // billable channel counter; removing a member decrements the member
  // counter. An admin-local copy would get the row deletion right and
  // quietly skip all of that.
  imports: [
    DrizzleModule,
    EmailModule,
    QueueModule,
    ChannelsModule,
    WorkspaceMembersModule,
    // The two-step reset: SecondFactorService.clear and SessionStore.revokeAll.
    SecurityCoreModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminAuditService,
    AdminAuditRetentionService,
    AdminActivityService,
    AdminLogsService,
    UserInactivityService,
    QueueMonitorService,
    // The two-step-disabled email of the reset. NotifyService and
    // RecipientsService are global; EmailTokensService and AppLinks come from
    // EmailModule. GeoipService is stateless (AuthModule keeps its own).
    TwoFactorNotices,
    GeoipService,
  ],
  exports: [
    AdminService,
    UserInactivityService,
    QueueMonitorService,
    AdminAuditService,
  ],
})
export class AdminModule {}
