import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

/** One-shot, idempotent webhook registration. Runs once per boot. If any of
 *  the required env vars are missing, logs a warning and skips — letting the
 *  backend boot cleanly in dev/test environments without Telegram. */
@Injectable()
export class TelegramBotSetupService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotSetupService.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.telegram.isConfigured()) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN not set — skipping Telegram webhook registration.',
      );
      return;
    }
    const baseUrl = this.config.get<string>('TELEGRAM_WEBHOOK_BASE_URL', '');
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET', '');
    if (!baseUrl || !secret) {
      this.logger.warn(
        'TELEGRAM_WEBHOOK_BASE_URL or TELEGRAM_WEBHOOK_SECRET missing — skipping webhook registration.',
      );
      return;
    }
    const url = `${baseUrl.replace(/\/$/, '')}/webhooks/telegram`;
    try {
      await this.telegram.setWebhook(url, secret);
      const me = await this.telegram.getMe();
      this.logger.log(
        `Telegram webhook registered for @${me.username ?? '?'} → ${url}`,
      );
    } catch (err) {
      this.logger.error(
        `Telegram webhook registration failed: ${(err as Error).message}`,
      );
    }
  }
}
