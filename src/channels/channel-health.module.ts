import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { ChannelHealthNotifier } from './services/channel-health-notifier.service';

/**
 * C2 reconnect notices on their own, so every writer of
 * `connection_status = 'expired'` can go through `markExpired`.
 *
 * AnalyticsModule's profile-snapshot handler is one of them, and ChannelsModule
 * imports AnalyticsModule: importing ChannelsModule from there would cycle.
 * Besides EmailModule (the once-claim and the app links) the notifier needs
 * only global providers: Drizzle, and NotificationsModule's NotifyService,
 * RecipientsService and NotificationEmitterService.
 */
@Module({
  imports: [EmailModule],
  providers: [ChannelHealthNotifier],
  exports: [ChannelHealthNotifier],
})
export class ChannelHealthModule {}
