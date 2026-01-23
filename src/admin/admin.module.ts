import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserInactivityService } from './user-inactivity.service';
import { QueueMonitorService } from './queue-monitor.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { EmailModule } from '../email/email.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [DrizzleModule, EmailModule, QueueModule],
  controllers: [AdminController],
  providers: [AdminService, UserInactivityService, QueueMonitorService],
  exports: [AdminService, UserInactivityService, QueueMonitorService],
})
export class AdminModule {}
