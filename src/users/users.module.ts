import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MediaModule } from '../media/media.module';
import { EmailModule } from '../email/email.module';
import { GeoipService } from '../auth/services/geoip.service';
import { AccountSecurityService } from './account-security.service';
import { EmailChangeService } from './email-change.service';
import { AccountSettingsController } from './account-settings.controller';
import { UserPreferencesService } from './preferences/user-preferences.service';
import { MyWorkspacesService } from './my-workspaces.service';

@Module({
  // For R2, which issues the presigned URL a profile picture is uploaded to.
  // EmailModule for the security-link tokens and AppLinks of the A5 email;
  // NotifyService and RecipientsService come from the global
  // NotificationsModule.
  imports: [MediaModule, EmailModule],
  // GeoipService is stateless; AuthModule keeps its own instance.
  providers: [
    UsersService,
    AccountSecurityService,
    EmailChangeService,
    UserPreferencesService,
    MyWorkspacesService,
    GeoipService,
  ],
  // AccountSecurityController lives in AuthModule (it needs AuthService).
  // AccountSettingsController stays FIRST: its `users/me/...` routes must be
  // registered before UsersController's `users/:id`.
  controllers: [AccountSettingsController, UsersController],
  exports: [UsersService, AccountSecurityService, EmailChangeService],
})
export class UsersModule {}
