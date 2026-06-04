import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationEmitterService } from './notification-emitter.service';
import { NotificationRoutesController } from './notification-routes.controller';
import { NotificationRoutesService } from './notification-routes.service';

@Global() // Make this module global so other services can inject NotificationsService
@Module({
  imports: [JwtModule.register({})],
  controllers: [NotificationsController, NotificationRoutesController],
  providers: [NotificationsService, NotificationsGateway, NotificationEmitterService, NotificationRoutesService],
  exports: [NotificationsService, NotificationsGateway, NotificationEmitterService, NotificationRoutesService],
})
export class NotificationsModule {}
