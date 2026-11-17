import {
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ChannelsModule } from '../channels.module';
import { WorkspaceRoleModule } from '../../workspace-members/workspace-role.module';
import { InboxModule } from '../../inbox/inbox.module';
import { MessagingOverviewController } from './messaging-overview.controller';
import { MessagingOverviewService } from './messaging-overview.service';
import { MESSAGING_REDIS } from './messaging-overview.constants';
import { closeRedisConnection } from '../../common/redis-connection-closer';

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

/** Gives the factory-built client above a shutdown hook it would not otherwise have. */
@Injectable()
class MessagingRedisCloser implements OnApplicationShutdown {
  constructor(@Inject(MESSAGING_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisConnection(this.redis);
  }
}

@Module({
  imports: [ConfigModule, ChannelsModule, InboxModule, WorkspaceRoleModule],
  controllers: [MessagingOverviewController],
  providers: [
    MessagingOverviewService,
    MessagingRedisProvider,
    MessagingRedisCloser,
  ],
})
export class MessagingOverviewModule {}
