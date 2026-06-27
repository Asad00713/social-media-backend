import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { TelegramService } from '../../../channels/services/telegram.service';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { MaestroService } from '../../services/maestro.service';
import {
  BridgeLinkService,
  type PendingChoice,
} from '../services/bridge-link.service';
import type { MaestroChannelLink } from '../../../drizzle/schema/maestro-links.schema';

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

interface TelegramCallbackQuery {
  id: string;
  from?: TelegramFrom;
  message?: { chat?: { id: number } };
  data?: string;
}

/**
 * Consumes inbound updates from the central Maestro Telegram bot:
 *  - `/start <token>` → verify the connect token, bind this Telegram user.
 *  - `/switch` → choose which workspace Maestro acts on (inline buttons).
 *  - any other text → run a headless Maestro turn and reply; questions/confirm
 *    cards render as inline keyboard buttons, media as link previews.
 *  - `callback_query` (a button tap) → resolve the stored pending choice and
 *    either feed the option back as the next turn or switch workspace.
 * Unlinked senders get a "connect first" nudge (no run billed).
 */
@Processor(QUEUES.MAESTRO_BRIDGE)
export class MaestroBridgeProcessor extends WorkerHost {
  private readonly logger = new Logger(MaestroBridgeProcessor.name);

  constructor(
    private readonly links: BridgeLinkService,
    private readonly maestro: MaestroService,
    private readonly telegram: TelegramService,
    private readonly workspaces: WorkspaceService,
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
    const update = job.data.update ?? {};
    const callback = update.callback_query as TelegramCallbackQuery | undefined;
    if (callback) {
      await this.handleCallback(callback);
      return;
    }

    const msg = (update.message ?? null) as TelegramMessage | null;
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
      '✅ Connected to Schedura. Send me anything — I can check your inbox, draft and publish posts, and more.\n\nTip: /switch to change which workspace I act on.',
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

    if (text === '/switch') {
      await this.showWorkspaceSwitch(chatId, link);
      return;
    }

    try {
      await this.runAndReply(chatId, link, text);
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

  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const tg = this.tg();
    await tg.answerCallbackQuery(cb.id).catch(() => undefined);
    const fromId = String(cb.from?.id ?? '');
    const chatId = cb.message?.chat?.id;
    if (!fromId || !chatId) return;

    const link = await this.links.findLink('telegram', fromId);
    if (!link) return;

    const pending = (link.metadata as { pending?: PendingChoice }).pending;
    const match = /^p:(\d+)$/.exec(String(cb.data ?? ''));
    if (!pending || !match) return; // stale tap — ignore
    const index = Number(match[1]);
    if (index < 0 || index >= pending.items.length) return;
    const value = pending.items[index];
    const label = pending.labels[index] ?? value;

    await this.links.setPending(link.id, null);

    if (pending.kind === 'workspace') {
      await this.links.setDefaultWorkspace(link.id, value);
      // Fresh conversation so context belongs to the newly-selected workspace.
      await this.links.setConversation(link.id, null);
      await tg.sendMessage(
        chatId,
        `✅ Switched to ${label}. Send me anything.`,
      );
      return;
    }

    // Question — feed the chosen option back as the next turn. The model re-calls
    // the pending tool with confirmed:true / the answer (history carries the ask).
    try {
      await this.runAndReply(chatId, link, value);
    } catch (err) {
      this.logger.error(
        `bridge callback run failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await tg.sendMessage(
        chatId,
        'Sorry — something went wrong on my end. Try again in a moment.',
      );
    }
  }

  /** Run a turn and render the result: text, media previews, question buttons. */
  private async runAndReply(
    chatId: number,
    link: MaestroChannelLink,
    message: string,
  ): Promise<void> {
    let conversationId = link.conversationId;
    if (!conversationId) {
      const conv = await this.maestro.createConversation(
        link.userId,
        link.defaultWorkspaceId,
      );
      conversationId = conv.id;
      await this.links.setConversation(link.id, conversationId);
    }

    const result = await this.maestro.runHeadlessTurn({
      conversationId,
      userId: link.userId,
      message,
      confirmBeforeSend: true,
    });

    const tg = this.tg();
    let sentSomething = false;
    if (result.text) {
      await tg.sendMessage(chatId, result.text);
      sentSomething = true;
    }
    if (result.media?.length) {
      for (const m of result.media) {
        await tg.sendMessage(chatId, m.url);
      }
      sentSomething = true;
    }

    const question = result.question?.questions[0];
    if (question && question.options.length) {
      await this.links.setPending(link.id, {
        kind: 'question',
        items: question.options,
        labels: question.options,
      });
      await tg.sendMessage(chatId, question.question, {
        replyMarkup: {
          inline_keyboard: question.options.map((opt, i) => [
            { text: opt, callback_data: `p:${i}` },
          ]),
        },
      });
      sentSomething = true;
      if ((result.question?.questions.length ?? 0) > 1) {
        // v1: only the first question is interactive on Telegram.
        this.logger.warn(
          `bridge: ${result.question?.questions.length} questions; rendered first only`,
        );
      }
    } else {
      await this.links.setPending(link.id, null);
    }

    if (!sentSomething) {
      await tg.sendMessage(chatId, '…');
    }
  }

  /** Offer the user's workspaces as inline buttons to pick the active one. */
  private async showWorkspaceSwitch(
    chatId: number,
    link: MaestroChannelLink,
  ): Promise<void> {
    const spaces = await this.workspaces.findAllByUser(link.userId);
    if (!spaces.length) {
      await this.tg().sendMessage(chatId, 'No workspaces found on your account.');
      return;
    }
    const items = spaces.map((s) => s.id);
    const labels = spaces.map((s) => s.name || 'Workspace');
    await this.links.setPending(link.id, { kind: 'workspace', items, labels });
    await this.tg().sendMessage(chatId, 'Which workspace should I act on?', {
      replyMarkup: {
        inline_keyboard: labels.map((l, i) => [
          { text: l, callback_data: `p:${i}` },
        ]),
      },
    });
  }
}
