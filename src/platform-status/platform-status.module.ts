import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AdminIncidentsController } from './admin-incidents.controller';
import { PlatformIncidentsService } from './platform-incidents.service';
import { PlatformStatusController } from './platform-status.controller';
import {
  PlatformStatusProcessor,
  PlatformStatusScheduler,
} from './platform-status.processor';
import { PlatformStatusRepository } from './platform-status.repository';
import { PlatformStatusService } from './platform-status.service';

/**
 * Publishing platform health: a two-minute measurement, incidents posted by
 * super admins, the in-app status page and the `platform.status.changed`
 * realtime event. RealtimeModule and DrizzleModule are global.
 */
@Module({
  imports: [QueueModule],
  controllers: [PlatformStatusController, AdminIncidentsController],
  providers: [
    PlatformStatusRepository,
    PlatformStatusService,
    PlatformIncidentsService,
    PlatformStatusScheduler,
    PlatformStatusProcessor,
  ],
})
export class PlatformStatusModule {}
