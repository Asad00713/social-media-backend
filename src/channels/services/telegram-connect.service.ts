import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ChannelService } from './channel.service';
import { InboxService } from '../../inbox/inbox.service';
import type { ChannelResponseDto } from '../dto/channel.dto';
import {
  deriveTelegramWebhookSecret,
  generateTelegramRouteId,
} from '../utils/telegram-webhook-secret.util';

@Injectable()
export class TelegramConnectService {
  private readonly logger = new Logger(TelegramConnectService.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly channelService: ChannelService,
    private readonly inbox: InboxService,
  ) {}

  async connect(
    workspaceId: string,
    userId: string,
    token: string,
  ): Promise<ChannelResponseDto> {
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, userId);

    const client = this.telegram.forToken(token.trim());

    // 1. Validate the token.
    let me: { id: number; first_name: string; username?: string };
    try {
      me = await client.getMe();
    } catch {
      throw new BadRequestException(
        'Invalid bot token. Re-copy it from @BotFather and try again.',
      );
    }

    // 2. Global uniqueness — Telegram allows exactly one webhook per bot.
    const existing = await this.channelService.findChannelByPlatformAccountGlobal(
      'telegram',
      String(me.id),
    );
    if (existing) {
      throw new ConflictException(
        'This bot is already connected. Disconnect it first, or use a different bot.',
      );
    }

    // 3. Route + derived secret, set the webhook, verify.
    const routeId = generateTelegramRouteId();
    const secret = deriveTelegramWebhookSecret(routeId);
    const base = (
      process.env.TELEGRAM_WEBHOOK_BASE_URL ||
      process.env.API_PUBLIC_URL ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    if (!base) {
      throw new BadRequestException(
        'Server webhook base URL is not configured.',
      );
    }
    const url = `${base}/webhooks/telegram/${routeId}`;
    await client.setWebhook(url, secret);
    const info = await client.getWebhookInfo();
    if (info.last_error_message) {
      this.logger.warn(
        `setWebhook verify warning for @${me.username}: ${info.last_error_message}`,
      );
    }

    // 4. Best-effort bot avatar.
    let profilePictureUrl: string | undefined;
    try {
      const fileId = await client.getUserProfilePhotoFileId(me.id);
      if (fileId) {
        const file = await client.getFile(fileId);
        if (file.file_path) {
          profilePictureUrl = `https://api.telegram.org/file/bot${token.trim()}/${file.file_path}`;
        }
      }
    } catch {
      // ignore — initials fallback in UI
    }

    // 5. Persist (createChannel encrypts the token).
    return this.channelService.createChannel(workspaceId, userId, {
      platform: 'telegram',
      accountType: 'bot',
      platformAccountId: String(me.id),
      accountName: me.first_name,
      username: (me.username ?? '').replace(/^@/, ''),
      profilePictureUrl,
      accessToken: token.trim(),
      telegramWebhookRouteId: routeId,
      permissions: [],
      capabilities: {
        canPost: false,
        canSchedule: false,
        canReadAnalytics: false,
        canReply: true,
        canDelete: true,
        supportedMediaTypes: ['image', 'video', 'audio', 'file'],
        maxMediaPerPost: 1,
        maxTextLength: 4096,
      },
      metadata: { mode: 'custom_bot', botId: me.id },
    } as any);
  }
}
