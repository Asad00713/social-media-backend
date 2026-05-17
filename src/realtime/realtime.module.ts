import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AnalyticsEventsGateway } from './analytics-events.gateway';
import { AnalyticsEventEmitter } from './analytics-event-emitter.service';

@Global() // expose emitter app-wide without per-module import
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  providers: [AnalyticsEventsGateway, AnalyticsEventEmitter],
  exports: [AnalyticsEventEmitter],
})
export class RealtimeModule {}
