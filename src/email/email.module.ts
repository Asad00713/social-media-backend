import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type Redis from 'ioredis';
import { JwtModule } from '@nestjs/jwt';
import {
  REDIS_CLIENT,
  RedisClientProvider,
} from '../channels/analytics/redis-client.provider';
import { NotificationPreferencesModule } from '../notification-preferences/notification-preferences.module';
import { QueueModule } from '../queue/queue.module';
import { PostFailureBatchService } from './batching/post-failure-batch.service';
import { EmailOnceService } from './email-once.service';
import { EmailService } from './email.service';
import { AppLinks } from './links/app-links';
import { EmailFooterService } from './queue/email-footer.service';
import { EmailOutboxService } from './queue/email-outbox.service';
import { EmailProcessor } from './queue/email.processor';
import { EmailPublicController } from './public/email-public.controller';
import { EmailSuppressionRepository } from './suppression/email-suppression.repository';
import { EmailTokensService } from './tokens/email-tokens.service';
import { ResendWebhookController } from './webhooks/resend-webhook.controller';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    QueueModule,
    NotificationPreferencesModule,
  ],
  controllers: [EmailPublicController, ResendWebhookController],
  providers: [
    EmailService,
    AppLinks,
    EmailOnceService,
    RedisClientProvider,
    EmailSuppressionRepository,
    EmailTokensService,
    EmailFooterService,
    EmailOutboxService,
    EmailProcessor,
    PostFailureBatchService,
  ],
  exports: [
    REDIS_CLIENT,
    EmailService,
    EmailOutboxService,
    AppLinks,
    EmailOnceService,
    EmailTokensService,
    EmailSuppressionRepository,
    PostFailureBatchService,
  ],
})
export class EmailModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * This module's own ioredis connection (EmailOnceService) closes on
   * shutdown. A connection that is not ready is dropped instead: QUIT would sit
   * in ioredis's offline queue and hold the shutdown up.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
