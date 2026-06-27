import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { TelegramService } from '../../../channels/services/telegram.service';
import { MaestroService } from '../../services/maestro.service';
import { BridgeLinkService } from '../services/bridge-link.service';

interface TelegramFrom {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  chat?: { id: number };
  from?: TelegramFrom;
  text?: string;
}

/**
 * Consumes inbound updates from the central Maestro Telegram bot. Two paths:
 *  - `/start <token>` → verify the connect token, bind this Telegram user to the
 *    Schedura account, confirm in-chat.
 *  - any other text → resolve the link, run a headless Maestro turn against the
 *    link's conversation, reply with the result. Unlinked senders get a
 *    "connect first" nudge (no run is billed for them).
 */
@Processor(QUEUES.MAESTRO_BRIDGE)
export class MaestroBridgeProcessor extends WorkerHost {
  private readonly logger = new Logger(MaestroBridgeProcessor.name);

  constructor(
    private readonly links: BridgeLinkService,
    private readonly maestro: MaestroService,
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  /** Central-bot client (its own token; falls back to the env default bot). */
  private tg() {
    return this.telegram.forToken(
      this.config.get<string>('MAESTRO_TELEGRAM_BOT_TOKEN') || undefined,
    );
  }

  async process(job: Job<{ update: Record<string, unknown> }>): Promise<void> {
    const msg = (job.data.update?.message ?? null) as TelegramMessage | null;
    if (!msg?.chat?.id || !msg.from?.id) return;
    const chatId = msg.chat.id;
    const fromId = String(msg.from.id);
    const text = String(msg.text ?? '').trim();
    if (!text) return;

    if (text.startsWith('/start')) {
      await this.handleStart(chatId, fromId, msg.from, text);
      return;
    }
    await this.handleMessage(chatId, fromId, text);
  }

  private async handleStart(
    chatId: number,
    fromId: string,
    from: TelegramFrom,
    text: string,
  ): Promise<void> {
    const token = text.slice('/start'.length).trim();
    const verified = token ? this.links.verifyLinkToken(token) : null;
    if (!verified) {
      await this.tg().sendMessage(
        chatId,
        'That connect link has expired. Open Schedura → Maestro → Connect Telegram to get a fresh link.',
      );
      return;
    }
    const displayName =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      from.username ||
      'Telegram user';
    await this.links.upsertLink({
      userId: verified.userId,
      channel: 'telegram',
      externalId: fromId,
      displayName,
      defaultWorkspaceId: verified.workspaceId,
    });
    await this.tg().sendMessage(
      chatId,
      '✅ Connected to Schedura. Send me anything — I can check your inbox, draft and publish posts, and more.',
    );
  }

  private async handleMessage(
    chatId: number,
    fromId: string,
    text: string,
  ): Promise<void> {
    const link = await this.links.findLink('telegram', fromId);
    if (!link) {
      const app =
        this.config.get<string>('APP_URL') ||
        this.config.get<string>('FRONTEND_URL') ||
        '';
      await this.tg().sendMessage(
        chatId,
        `You're not connected yet. Open Schedura → Maestro → Connect Telegram${
          app ? ` (${app})` : ''
        } to link your account.`,
      );
      return;
    }

    let conversationId = link.conversationId;
    if (!conversationId) {
      const conv = await this.maestro.createConversation(
        link.userId,
        link.defaultWorkspaceId,
      );
      conversationId = conv.id;
      await this.links.setConversation(link.id, conversationId);
    }

    try {
      const { text: reply } = await this.maestro.runHeadlessTurn({
        conversationId,
        userId: link.userId,
        message: text,
        confirmBeforeSend: true,
      });
      await this.tg().sendMessage(chatId, reply || '…');
    } catch (err) {
      this.logger.error(
        `bridge run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.tg().sendMessage(
        chatId,
        'Sorry — something went wrong on my end. Try again in a moment.',
      );
    }
  }
}
