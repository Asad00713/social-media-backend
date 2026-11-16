import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesRepository } from './notification-preferences.repository';
import { NotificationPreferencesService } from './notification-preferences.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [NotificationPreferencesController],
  providers: [
    NotificationPreferencesRepository,
    NotificationPreferencesService,
  ],
  exports: [NotificationPreferencesService],
})
export class NotificationPreferencesModule {}
