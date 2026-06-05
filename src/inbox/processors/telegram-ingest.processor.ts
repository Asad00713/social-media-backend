import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { telegramChatBindings } from '../../drizzle/schema/telegram-bindings.schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import { TelegramService, type TgMessage } from '../../channels/services/telegram.service';

@Processor(QUEUES.TELEGRAM_INGEST)
export class TelegramIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramIngestProcessor.name);
  /** Cached bot user — populated lazily so we can recognise our own messages. */
  private botId: number | null = null;

  constructor(
    private readonly inbox: InboxService,
    private readonly telegram: TelegramService,
  ) {
    super();
  }

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    const update = job.data;
    const message = update.message as TgMessage | undefined;
    if (!message) return;

    // Lazily resolve our bot id once.
    if (this.botId === null) {
      try {
        const me = await this.telegram.getMe();
        this.botId = me.id;
      } catch (err) {
        this.logger.error(`getMe failed: ${(err as Error).message}`);
        return;
      }
    }

    if (message.from?.is_bot && message.from.id === this.botId) return;

    const text = message.text ?? '';

    // /start <workspaceId> binding flow (DM only)
    if (text.startsWith('/start') && message.chat.type === 'private') {
      const arg = text.split(/\s+/)[1];
      if (arg) {
        await this.handleStartBinding(arg, message);
      } else {
        await this.telegram.sendMessage(
          message.chat.id,
          'Hi! To connect this Telegram account to Schedura, click "Connect Telegram" from your Schedura dashboard.',
        );
      }
      return;
    }

    // Text DM ingest (media handled in Task 9)
    await this.ingestPlainMessage(message);
  }

  private async handleStartBinding(
    workspaceId: string,
    message: TgMessage,
  ): Promise<void> {
    const [ws] = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws) {
      await this.telegram.sendMessage(
        message.chat.id,
        `Unknown workspace id. Please re-open the Connect Telegram link from your Schedura dashboard.`,
      );
      return;
    }

    const channel = await this.ensureTelegramChannel(workspaceId);

    await db
      .insert(telegramChatBindings)
      .values({
        workspaceId,
        telegramChatId: String(message.chat.id),
        chatType: 'private',
        boundByTelegramUserId: message.from ? String(message.from.id) : null,
      })
      .onConflictDoNothing();

    await this.telegram.sendMessage(
      message.chat.id,
      'Connected to Schedura ✅ — your messages will now appear in the workspace inbox.',
    );

    this.logger.log(
      `Telegram DM bound: workspace=${workspaceId}, chat=${message.chat.id}, channel=${channel.id}`,
    );
  }

  private async ingestPlainMessage(message: TgMessage): Promise<void> {
    const chatIdStr = String(message.chat.id);
    const [binding] = await db
      .select()
      .from(telegramChatBindings)
      .where(eq(telegramChatBindings.telegramChatId, chatIdStr))
      .limit(1);
    if (!binding) return;

    const channel = await this.ensureTelegramChannel(binding.workspaceId);

    const from = message.from;
    const displayName = from
      ? [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
        from.username ||
        'Telegram user'
      : 'Telegram user';

    const resolvedText = this.telegram.resolveEntities(
      message.text ?? message.caption ?? '',
      message.entities ?? message.caption_entities,
    );

    await this.inbox.upsertDm({
      workspaceId: binding.workspaceId,
      channelId: channel.id,
      platform: 'telegram',
      conversationId: chatIdStr,
      platformItemId: String(message.message_id),
      platformParentId: message.reply_to_message
        ? String(message.reply_to_message.message_id)
        : null,
      authorPlatformId: from ? String(from.id) : null,
      authorHandle: from?.username ?? null,
      authorDisplayName: displayName,
      authorAvatarUrl: null,
      text: resolvedText,
      fromMe: false,
      platformCreatedAt: new Date(message.date * 1000),
      metadata: { chatType: message.chat.type },
    });
  }

  /** Lazy creation of the workspace's single socialMediaChannels row for
   *  Telegram. Uses platformAccountId='shared' to mark the shared-bot model.
   *  accessToken is set to '' (empty sentinel) because the bot token lives in
   *  env, not in the DB. connectedByUserId is set to the workspace owner so
   *  the NOT NULL constraint is satisfied. */
  private async ensureTelegramChannel(workspaceId: string) {
    const [existing] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.platform, 'telegram'),
        ),
      )
      .limit(1);
    if (existing) return existing;

    // Resolve workspace owner to satisfy connectedByUserId NOT NULL.
    const [ws] = await db
      .select({ ownerId: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    const [created] = await db
      .insert(socialMediaChannels)
      .values({
        workspaceId,
        platform: 'telegram',
        accountType: 'bot',
        platformAccountId: 'shared',
        accountName: 'Schedura Telegram Bot',
        username: 'ScheduraBot',
        // accessToken must be non-null per schema; bot token lives in env.
        accessToken: '',
        profilePictureUrl: null,
        metadata: { mode: 'shared_bot' },
        connectedByUserId: ws.ownerId,
      })
      .returning();
    return created;
  }
}
