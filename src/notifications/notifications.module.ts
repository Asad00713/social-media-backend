import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationEmitterService } from './notification-emitter.service';

@Global() // Make this module global so other services can inject NotificationsService
@Module({
  imports: [JwtModule.register({})],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway, NotificationEmitterService],
  exports: [NotificationsService, NotificationsGateway, NotificationEmitterService],
})
export class NotificationsModule {}
