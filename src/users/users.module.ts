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
import { AccountDeletionService } from './account-deletion.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  // For R2, which issues the presigned URL a profile picture is uploaded to.
  // EmailModule for the security-link tokens and AppLinks of the A5 email;
  // NotifyService and RecipientsService come from the global
  // NotificationsModule. BillingModule for the account delete, which cancels
  // the subscription and decrements member counts (it does not import this
  // module back, so there is no cycle).
  imports: [MediaModule, EmailModule, BillingModule],
  // GeoipService is stateless; AuthModule keeps its own instance.
  providers: [
    UsersService,
    AccountSecurityService,
    EmailChangeService,
    UserPreferencesService,
    MyWorkspacesService,
    AccountDeletionService,
    GeoipService,
  ],
  // AccountSecurityController lives in AuthModule (it needs AuthService).
  // AccountSettingsController stays FIRST: its `users/me` routes (including
  // DELETE /users/me) must be registered before UsersController's
  // `users/:id`, or `me` is taken for an id.
  controllers: [AccountSettingsController, UsersController],
  exports: [
    UsersService,
    AccountSecurityService,
    EmailChangeService,
    AccountDeletionService,
  ],
})
export class UsersModule {}
