import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { LogWriterService } from './log-writer.service';
import { AppLoggerService } from './app-logger.service';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LogRetentionService } from './log-retention.service';

@Module({
  imports: [DrizzleModule],
  providers: [
    LogWriterService,
    AppLoggerService,
    AllExceptionsFilter,
    LogRetentionService,
  ],
  exports: [LogWriterService, AppLoggerService, AllExceptionsFilter],
})
export class LogsModule {}
