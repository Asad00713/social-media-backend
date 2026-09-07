import { Module, Global, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationEmitterService } from './notification-emitter.service';
import { NotificationRoutesController } from './notification-routes.controller';
import { NotificationRoutesService } from './notification-routes.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { ChannelsModule } from '../channels/channels.module';

@Global() // Make this module global so other services can inject NotificationsService
@Module({
  // ChannelsModule now imports BillingModule (channels are pooled per account,
  // so connecting one needs the account-wide ceiling), and BillingModule
  // imports this module — Channels -> Billing -> Notifications -> Channels.
  // Both sides of that cycle must be forwardRef'd or Nest cannot build it.
  imports: [JwtModule.register({}), forwardRef(() => ChannelsModule)],
  controllers: [NotificationsController, NotificationRoutesController],
  providers: [
    NotificationsService,
    NotificationsGateway,
    NotificationEmitterService,
    NotificationRoutesService,
    NotificationDispatcherService,
  ],
  exports: [
    NotificationsService,
    NotificationsGateway,
    NotificationEmitterService,
    NotificationRoutesService,
  ],
})
export class NotificationsModule {}
