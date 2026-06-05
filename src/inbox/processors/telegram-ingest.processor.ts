import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { telegramChatBindings } from '../../drizzle/schema/telegram-bindings.schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import { TelegramService, type TgMessage, type TgInlineKeyboardButton } from '../../channels/services/telegram.service';

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
    // Spec note: implementer adds these two branches.
    // The runtime `any` casts are intentional — Telegram's update envelopes have
    // optional nested fields we don't type fully here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const myChatMember = update.my_chat_member as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callbackQuery = update.callback_query as any;

    // Lazy bot id resolution (must come BEFORE the routing branches below so
    // botId is available when handleMyChatMember reads it).
    if (this.botId === null) {
      try {
        const me = await this.telegram.getMe();
        this.botId = me.id;
      } catch (err) {
        this.logger.error(
          `getMe failed for job ${job.id} — will retry: ${(err as Error).message}`,
        );
        throw err;
      }
    }

    if (callbackQuery) {
      await this.handleCallbackQuery(callbackQuery);
      return;
    }
    if (myChatMember) {
      await this.handleMyChatMember(myChatMember);
      return;
    }
    if (!message) return;

    // -- below this point is the EXISTING Task 6 body: bot-self filter, /start
    //    routing, ingestPlainMessage call. Keep it as it is. --

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
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(workspaceId)) {
      await this.telegram.sendMessage(
        message.chat.id,
        'Unknown workspace id. Please re-open the Connect Telegram link from your Schedura dashboard.',
      );
      return;
    }

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

    if (!ws) {
      throw new Error(`ensureTelegramChannel: workspace ${workspaceId} not found`);
    }

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
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    // Conflict fired — another concurrent call already inserted. Refetch.
    const [refetched] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.platform, 'telegram'),
        ),
      )
      .limit(1);
    if (!refetched) {
      throw new Error(
        `ensureTelegramChannel: insert conflict but no row found for workspace ${workspaceId}`,
      );
    }
    return refetched;
  }

  /** Telegram pings us with `my_chat_member` whenever the bot's membership
   *  status in a chat changes. We only care about "bot was added to a group
   *  by user X" — anything else is ignored. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMyChatMember(evt: any): Promise<void> {
    const newStatus = evt.new_chat_member?.status as string | undefined;
    const newUserId = evt.new_chat_member?.user?.id as number | undefined;
    const chat = evt.chat as { id: number; type: string; title?: string } | undefined;
    const inviter = evt.from as { id: number; username?: string; first_name?: string } | undefined;

    if (!chat || !inviter || !newUserId) return;
    if (newUserId !== this.botId) return;
    if (newStatus !== 'member' && newStatus !== 'administrator') return;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    const inviterBindings = await db
      .select({ workspaceId: telegramChatBindings.workspaceId })
      .from(telegramChatBindings)
      .where(
        and(
          eq(telegramChatBindings.boundByTelegramUserId, String(inviter.id)),
          eq(telegramChatBindings.chatType, 'private'),
        ),
      );

    if (inviterBindings.length === 0) {
      await this.telegram.sendMessage(
        chat.id,
        `Hi! No Schedura workspace is connected for the user who added me. Please connect Telegram from your Schedura dashboard first, then try again.`,
      );
      return;
    }

    // Limit keyboard to 5 workspaces to keep it compact (Telegram limit is
    // higher but 5 covers nearly every real user).
    const wsIds = inviterBindings.slice(0, 5).map((b) => b.workspaceId);
    const workspaces = await db
      .select({ id: workspace.id, name: workspace.name })
      .from(workspace)
      .where(inArray(workspace.id, wsIds));

    const buttons: TgInlineKeyboardButton[][] = workspaces.map((w) => [
      { text: w.name, callback_data: `tg-bind:${w.id}` },
    ]);

    await this.telegram.sendMessage(
      chat.id,
      `Hi! Pick a Schedura workspace to connect this group to:`,
      { replyMarkup: { inline_keyboard: buttons } },
    );
  }

  /** Inviter (or another user) tapped a workspace button. Verify the tapper
   *  themselves owns a DM binding to that workspace (security — prevents random
   *  group members from binding the bot to someone else's workspace), insert
   *  the group binding row, ack callback, edit message to success state. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleCallbackQuery(cbq: any): Promise<void> {
    const data: string | undefined = cbq.data;
    const cbqId: string | undefined = cbq.id;
    const tapperId: number | undefined = cbq.from?.id;
    const chat = cbq.message?.chat as { id: number; type: string; title?: string } | undefined;
    const messageId: number | undefined = cbq.message?.message_id;

    if (!cbqId) return;
    if (!data || !tapperId || !chat || !messageId) {
      await this.telegram.answerCallbackQuery(cbqId, '', false);
      return;
    }
    if (!data.startsWith('tg-bind:')) return;

    const workspaceId = data.slice('tg-bind:'.length);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(workspaceId)) {
      await this.telegram.answerCallbackQuery(cbqId, 'Invalid workspace.', true);
      return;
    }
    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      await this.telegram.answerCallbackQuery(
        cbqId,
        'Only groups can be bound this way.',
        true,
      );
      return;
    }

    const [tapperBinding] = await db
      .select()
      .from(telegramChatBindings)
      .where(
        and(
          eq(telegramChatBindings.workspaceId, workspaceId),
          eq(telegramChatBindings.boundByTelegramUserId, String(tapperId)),
          eq(telegramChatBindings.chatType, 'private'),
        ),
      )
      .limit(1);
    if (!tapperBinding) {
      await this.telegram.answerCallbackQuery(
        cbqId,
        'You are not authorised to bind this workspace.',
        true,
      );
      return;
    }

    try {
      await this.ensureTelegramChannel(workspaceId);
      await db
        .insert(telegramChatBindings)
        .values({
          workspaceId,
          telegramChatId: String(chat.id),
          chatType: chat.type as 'group' | 'supergroup',
          boundByTelegramUserId: String(tapperId),
        })
        .onConflictDoNothing();
    } catch (err) {
      this.logger.error(
        `Group bind DB write failed for workspace ${workspaceId}: ${(err as Error).message}`,
      );
      await this.telegram.answerCallbackQuery(
        cbqId,
        'Connection failed. Please try again.',
        true,
      );
      return;
    }

    await this.telegram.answerCallbackQuery(cbqId, 'Group connected ✅');
    try {
      await this.telegram.editMessageText(
        chat.id,
        messageId,
        `Group connected to Schedura ✅`,
      );
    } catch (err) {
      this.logger.warn(
        `editMessageText after bind failed (non-blocking): ${(err as Error).message}`,
      );
    }
  }
}
