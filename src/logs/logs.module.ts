import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { LogWriterService } from './log-writer.service';
import { AppLoggerService } from './app-logger.service';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LogRetentionService } from './log-retention.service';
import { requestContextMiddleware } from './request-context';

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
export class LogsModule implements NestModule {
  // Nest installs module middleware after its body parsers, so the
  // AsyncLocalStorage scope opened here survives into guards, handlers, the
  // logger and the exception filter (request-context.ts says why it can't
  // open earlier).
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(requestContextMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
