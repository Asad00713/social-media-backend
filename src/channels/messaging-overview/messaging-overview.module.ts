import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ChannelsModule } from '../channels.module';
import { InboxModule } from '../../inbox/inbox.module';
import { MessagingOverviewController } from './messaging-overview.controller';
import { MessagingOverviewService } from './messaging-overview.service';

export const MESSAGING_REDIS = 'MESSAGING_REDIS';

const MessagingRedisProvider: Provider = {
  provide: MESSAGING_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD', ''),
      ...(config.get<string>('REDIS_TLS') === 'true' && { tls: {} }),
      maxRetriesPerRequest: null,
    }),
};

@Module({
  imports: [ConfigModule, ChannelsModule, InboxModule],
  controllers: [MessagingOverviewController],
  providers: [MessagingOverviewService, MessagingRedisProvider],
})
export class MessagingOverviewModule {}
