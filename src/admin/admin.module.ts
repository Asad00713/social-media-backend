import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserInactivityService } from './user-inactivity.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [DrizzleModule, EmailModule],
  controllers: [AdminController],
  providers: [AdminService, UserInactivityService],
  exports: [AdminService, UserInactivityService],
})
export class AdminModule {}
