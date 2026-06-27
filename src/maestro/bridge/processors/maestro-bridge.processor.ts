import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { TelegramService } from '../../../channels/services/telegram.service';
import { WhatsAppService } from '../../../channels/services/whatsapp.service';
import { parseWhatsAppMessages } from '../../../channels/services/whatsapp-webhook.util';
import { WorkspaceService } from '../../../workspace/workspace.service';
import {
  MaestroService,
  type HeadlessTurnResult,
} from '../../services/maestro.service';
import {
  BridgeLinkService,
  type PendingChoice,
} from '../services/bridge-link.service';
import type { MaestroChannelLink } from '../../../drizzle/schema/maestro-links.schema';

/** Idle gap after which the next bridge message starts a fresh session/thread. */
const SESSION_GAP_MS = 12 * 60 * 60 * 1000;

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

/** Channel-agnostic way to push a reply / a choice prompt back to the user. */
interface BridgeReplier {
  sendText(text: string): Promise<void>;
  /** Render a list of options (inline buttons on Telegram, numbered on WhatsApp). */
  sendChoices(prompt: string, labels: string[]): Promise<void>;
}

/**
 * Consumes inbound updates from the central Maestro bots (Telegram + WhatsApp).
 * Linking, headless runs, questions/confirm and `/switch` are channel-agnostic;
 * only the transport (how a message/choice is sent and parsed) differs per
 * channel. Unlinked senders get a "connect first" nudge (no run billed).
 */
@Processor(QUEUES.MAESTRO_BRIDGE)
export class MaestroBridgeProcessor extends WorkerHost {
  private readonly logger = new Logger(MaestroBridgeProcessor.name);

  constructor(
    private readonly links: BridgeLinkService,
    private readonly maestro: MaestroService,
    private readonly telegram: TelegramService,
    private readonly whatsapp: WhatsAppService,
    private readonly workspaces: WorkspaceService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(
    job: Job<{
      channel?: 'telegram' | 'whatsapp';
      update?: Record<string, unknown>;
      payload?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const channel = job.data.channel ?? 'telegram';
    if (channel === 'whatsapp') {
      await this.handleWhatsApp(job.data.payload ?? {});
      return;
    }
    await this.handleTelegram(job.data.update ?? {});
  }

  // ==========================================================================
  // Telegram transport
  // ==========================================================================

  /** Central-bot client (its own token; falls back to the env default bot). */
  private tg() {
    return this.telegram.forToken(
      this.config.get<string>('MAESTRO_TELEGRAM_BOT_TOKEN') || undefined,
    );
  }

  private telegramReplier(chatId: number): BridgeReplier {
    const tg = this.tg();
    return {
      sendText: async (text) => {
        await tg.sendMessage(chatId, text);
      },
      sendChoices: async (prompt, labels) => {
        await tg.sendMessage(chatId, prompt, {
          replyMarkup: {
            inline_keyboard: labels.map((l, i) => [
              { text: l, callback_data: `p:${i}` },
            ]),
          },
        });
      },
    };
  }

  private async handleTelegram(update: Record<string, unknown>): Promise<void> {
    const callback = update.callback_query as TelegramCallbackQuery | undefined;
    if (callback) {
      await this.handleTelegramCallback(callback);
      return;
    }

    const msg = (update.message ?? null) as TelegramMessage | null;
    if (!msg?.chat?.id || !msg.from?.id) return;
    const chatId = msg.chat.id;
    const fromId = String(msg.from.id);
    const text = String(msg.text ?? '').trim();
    if (!text) return;
    const replier = this.telegramReplier(chatId);

    if (text.startsWith('/start')) {
      const token = text.slice('/start'.length).trim();
      await this.linkAccount(replier, 'telegram', fromId, token, this.telegramName(msg.from));
      return;
    }

    const link = await this.links.findLink('telegram', fromId);
    if (!link) {
      await replier.sendText(this.connectNudge());
      return;
    }
    if (text === '/switch') {
      await this.showWorkspaceSwitch(replier, link);
      return;
    }
    if (text === '/new') {
      await this.startNewSession(replier, link);
      return;
    }
    await this.safeRun(replier, link, text, 'telegram');
  }

  private async handleTelegramCallback(
    cb: TelegramCallbackQuery,
  ): Promise<void> {
    await this.tg()
      .answerCallbackQuery(cb.id)
      .catch(() => undefined);
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
    await this.applyChoice(
      this.telegramReplier(chatId),
      link,
      pending,
      index,
      'telegram',
    );
  }

  private telegramName(from: TelegramFrom): string {
    return (
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      from.username ||
      'Telegram user'
    );
  }

  // ==========================================================================
  // WhatsApp transport
  // ==========================================================================

  private whatsappReplier(waId: string): BridgeReplier {
    const token = this.config.get<string>('MAESTRO_WHATSAPP_TOKEN') || '';
    const pnid =
      this.config.get<string>('MAESTRO_WHATSAPP_PHONE_NUMBER_ID') || '';
    const send = (text: string) =>
      this.whatsapp.sendText(token, pnid, waId, text);
    return {
      sendText: async (text) => {
        await send(text);
      },
      sendChoices: async (prompt, labels) => {
        const list = labels.map((l, i) => `${i + 1}. ${l}`).join('\n');
        await send(`${prompt}\n\n${list}\n\nReply with the number.`);
      },
    };
  }

  private async handleWhatsApp(payload: Record<string, unknown>): Promise<void> {
    const pnid = this.config.get<string>('MAESTRO_WHATSAPP_PHONE_NUMBER_ID');
    if (!pnid) return; // bridge not configured
    const messages = parseWhatsAppMessages(payload).filter(
      (m) => m.isText && m.phoneNumberId === pnid && m.fromWaId,
    );
    for (const m of messages) {
      try {
        await this.handleWhatsAppMessage(m.fromWaId, m.text.trim(), m.authorName);
      } catch (err) {
        this.logger.error(
          `whatsapp bridge failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async handleWhatsAppMessage(
    waId: string,
    text: string,
    authorName?: string,
  ): Promise<void> {
    const replier = this.whatsappReplier(waId);
    if (!text) return;

    if (text.toLowerCase().startsWith('connect ')) {
      const token = text.slice('connect '.length).trim();
      await this.linkAccount(
        replier,
        'whatsapp',
        waId,
        token,
        authorName || 'WhatsApp user',
      );
      return;
    }

    const link = await this.links.findLink('whatsapp', waId);
    if (!link) {
      await replier.sendText(this.connectNudge());
      return;
    }
    if (text === '/switch') {
      await this.showWorkspaceSwitch(replier, link);
      return;
    }
    if (text === '/new') {
      await this.startNewSession(replier, link);
      return;
    }

    // If a choice is pending, try to resolve the reply (number or label).
    const pending = (link.metadata as { pending?: PendingChoice }).pending;
    if (pending) {
      const index = this.resolveChoice(pending, text);
      if (index !== null) {
        await this.applyChoice(replier, link, pending, index, 'whatsapp');
        return;
      }
      // Not a choice — fall through and treat as a fresh message.
      await this.links.setPending(link.id, null);
    }
    await this.safeRun(replier, link, text, 'whatsapp');
  }

  /** Map a free-text WhatsApp reply onto a pending choice index, or null. */
  private resolveChoice(pending: PendingChoice, text: string): number | null {
    const t = text.trim().toLowerCase();
    const num = Number(t);
    if (Number.isInteger(num) && num >= 1 && num <= pending.items.length) {
      return num - 1;
    }
    const byLabel = pending.labels.findIndex((l) => l.toLowerCase() === t);
    return byLabel >= 0 ? byLabel : null;
  }

  // ==========================================================================
  // Channel-agnostic core
  // ==========================================================================

  private connectNudge(): string {
    const app =
      this.config.get<string>('APP_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      '';
    return `You're not connected yet. Open Schedura → Maestro → Connect${
      app ? ` (${app})` : ''
    } to link your account.`;
  }

  /** Verify a connect token and bind this external identity to the account. */
  private async linkAccount(
    replier: BridgeReplier,
    channel: 'telegram' | 'whatsapp',
    externalId: string,
    token: string,
    displayName: string,
  ): Promise<void> {
    const verified = token ? this.links.verifyLinkToken(token) : null;
    if (!verified) {
      await replier.sendText(
        'That connect link has expired. Open Schedura → Maestro → Connect to get a fresh link.',
      );
      return;
    }
    await this.links.upsertLink({
      userId: verified.userId,
      channel,
      externalId,
      displayName,
      defaultWorkspaceId: verified.workspaceId,
    });
    await replier.sendText(
      '✅ Connected to Schedura. Send me anything — I can check your inbox, draft and publish posts, and more.\n\nTips: /switch to change workspace · /new for a fresh chat.',
    );
  }

  private async safeRun(
    replier: BridgeReplier,
    link: MaestroChannelLink,
    message: string,
    channel: 'telegram' | 'whatsapp',
  ): Promise<void> {
    try {
      await this.runAndReply(replier, link, message, channel);
    } catch (err) {
      this.logger.error(
        `bridge run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await replier.sendText(
        'Sorry — something went wrong on my end. Try again in a moment.',
      );
    }
  }

  /** Ensure a conversation, run a headless turn, render the result. */
  private async runAndReply(
    replier: BridgeReplier,
    link: MaestroChannelLink,
    message: string,
    channel: 'telegram' | 'whatsapp',
  ): Promise<void> {
    // One shared thread per (user, workspace) — every linked number/channel for
    // this workspace continues the same conversation, until it goes idle past
    // SESSION_GAP_MS (then the next message rolls a fresh session).
    const existing = await this.links.getThread(
      link.userId,
      link.defaultWorkspaceId,
    );
    let conversationId: string;
    if (existing && Date.now() - existing.updatedAt.getTime() < SESSION_GAP_MS) {
      conversationId = existing.conversationId;
      await this.links.touchThread(link.userId, link.defaultWorkspaceId);
    } else {
      const conv = await this.maestro.createConversation(
        link.userId,
        link.defaultWorkspaceId,
      );
      conversationId = conv.id;
      await this.links.setThreadConversation(
        link.userId,
        link.defaultWorkspaceId,
        conversationId,
      );
    }
    const result = await this.maestro.runHeadlessTurn({
      conversationId,
      userId: link.userId,
      message,
      confirmBeforeSend: true,
      sourceChannel: channel,
    });
    await this.renderResult(replier, link, result);
  }

  /** Send text + media previews, and render any question as a choice prompt. */
  private async renderResult(
    replier: BridgeReplier,
    link: MaestroChannelLink,
    result: HeadlessTurnResult,
  ): Promise<void> {
    let sent = false;
    if (result.text) {
      await replier.sendText(result.text);
      sent = true;
    }
    if (result.media?.length) {
      for (const m of result.media) {
        await replier.sendText(m.url);
      }
      sent = true;
    }

    const question = result.question?.questions[0];
    if (question && question.options.length) {
      await this.links.setPending(link.id, {
        kind: 'question',
        items: question.options,
        labels: question.options,
      });
      await replier.sendChoices(question.question, question.options);
      sent = true;
      if ((result.question?.questions.length ?? 0) > 1) {
        this.logger.warn(
          `bridge: ${result.question?.questions.length} questions; rendered first only`,
        );
      }
    } else {
      await this.links.setPending(link.id, null);
    }

    if (!sent) await replier.sendText('…');
  }

  /** Resolve a tapped/typed choice: switch workspace, or feed the option back. */
  private async applyChoice(
    replier: BridgeReplier,
    link: MaestroChannelLink,
    pending: PendingChoice,
    index: number,
    channel: 'telegram' | 'whatsapp',
  ): Promise<void> {
    await this.links.setPending(link.id, null);
    const value = pending.items[index];
    const label = pending.labels[index] ?? value;

    if (pending.kind === 'workspace') {
      await this.links.setDefaultWorkspace(link.id, value);
      // No conversation reset needed — each workspace resolves its own shared
      // thread on the next message.
      await replier.sendText(`✅ Switched to ${label}. Send me anything.`);
      return;
    }

    // Question — feed the chosen option back as the next turn. The model re-calls
    // the pending tool with confirmed:true / the answer (history carries the ask).
    await this.safeRun(replier, link, value, channel);
  }

  /** Roll a fresh session — the next message starts a new conversation. */
  private async startNewSession(
    replier: BridgeReplier,
    link: MaestroChannelLink,
  ): Promise<void> {
    await this.links.resetThread(link.userId, link.defaultWorkspaceId);
    await replier.sendText(
      '🆕 Started a fresh session. Your previous chat is saved in Schedura.',
    );
  }

  /** Offer the user's workspaces as a choice to pick the active one. */
  private async showWorkspaceSwitch(
    replier: BridgeReplier,
    link: MaestroChannelLink,
  ): Promise<void> {
    const spaces = await this.workspaces.findAllByUser(link.userId);
    if (!spaces.length) {
      await replier.sendText('No workspaces found on your account.');
      return;
    }
    const items = spaces.map((s) => s.id);
    const labels = spaces.map((s) => s.name || 'Workspace');
    await this.links.setPending(link.id, { kind: 'workspace', items, labels });
    await replier.sendChoices('Which workspace should I act on?', labels);
  }
}
