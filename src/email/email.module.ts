import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisClientProvider } from '../channels/analytics/redis-client.provider';
import { NotificationPreferencesModule } from '../notification-preferences/notification-preferences.module';
import { QueueModule } from '../queue/queue.module';
import { EmailOnceService } from './email-once.service';
import { EmailService } from './email.service';
import { AppLinks } from './links/app-links';
import { EmailFooterService } from './queue/email-footer.service';
import { EmailOutboxService } from './queue/email-outbox.service';
import { EmailProcessor } from './queue/email.processor';
import { EmailSuppressionRepository } from './suppression/email-suppression.repository';

@Module({
  imports: [ConfigModule, QueueModule, NotificationPreferencesModule],
  providers: [
    EmailService,
    AppLinks,
    EmailOnceService,
    RedisClientProvider,
    EmailSuppressionRepository,
    EmailFooterService,
    EmailOutboxService,
    EmailProcessor,
  ],
  exports: [EmailService, EmailOutboxService, AppLinks, EmailOnceService],
})
export class EmailModule {}
