import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import {
  TelegramService,
  TelegramClient,
  type TgMessage,
} from '../../channels/services/telegram.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { R2MediaKind } from '../../media/cloudflare-r2.service';
import { ChannelService } from '../../channels/services/channel.service';

@Processor(QUEUES.TELEGRAM_INGEST)
export class TelegramIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramIngestProcessor.name);
  /** Per-author avatar cache (telegram user id → R2 url | null). Avoids
   *  re-fetching + re-uploading a profile photo for every message. null is
   *  cached too, so photo-less / privacy-restricted users aren't re-queried
   *  for the process lifetime. Survives restarts via the DB-reuse path. */
  private readonly avatarCache = new Map<string, string | null>();

  constructor(
    private readonly inbox: InboxService,
    private readonly telegram: TelegramService,
    private readonly r2: CloudflareR2Service,
    private readonly channelService: ChannelService,
  ) {
    super();
  }

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    const channelId = job.data.channelId as number;
    const workspaceId = job.data.workspaceId as string;
    const update = job.data.update as Record<string, unknown>;
    if (!channelId || !workspaceId || !update) {
      this.logger.warn(`Telegram ingest: malformed job ${job.id} — skipping`);
      return;
    }

    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    if (!channel) {
      this.logger.warn(`Telegram ingest: channel ${channelId} not found`);
      return;
    }
    const botId = Number(channel.platformAccountId);
    const token = await this.channelService.getAccessToken(
      channelId,
      workspaceId,
    );
    const tg = this.telegram.forToken(token);

    const message = update.message as TgMessage | undefined;
    if (!message) return; // edited_message / callback_query / my_chat_member: ignored in this phase
    if (message.from?.is_bot && message.from.id === botId) return;

    await this.ingestPlainMessage(tg, channel, workspaceId, message);
  }

  private async ingestPlainMessage(
    tg: TelegramClient,
    channel: typeof socialMediaChannels.$inferSelect,
    workspaceId: string,
    message: TgMessage,
  ): Promise<void> {
    const chatIdStr = String(message.chat.id);

    const from = message.from;
    const displayName = from
      ? [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
        from.username ||
        'Telegram user'
      : 'Telegram user';

    const resolvedText = tg.resolveEntities(
      message.text ?? message.caption ?? '',
      message.entities ?? message.caption_entities,
    );

    const authorAvatarUrl = from
      ? await this.resolveAuthorAvatar(
          tg,
          String(from.id),
          workspaceId,
          channel.id,
        )
      : null;

    // Phase 1.B media rehost — Slack-parity pattern: download from Telegram
    // CDN with bot token, upload to R2, store the durable public URL.
    type RehostedAttachment = {
      kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
      url: string;
      contentType?: string;
    };
    const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
    const rehosted: RehostedAttachment[] = [];

    type MediaRef = {
      field:
        | 'photo'
        | 'voice'
        | 'audio'
        | 'video'
        | 'video_note'
        | 'document'
        | 'sticker';
      fileId: string;
      size?: number;
      mime?: string;
      filename?: string;
    };
    const mediaRefs: MediaRef[] = [];
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      mediaRefs.push({
        field: 'photo',
        fileId: largest.file_id,
        size: largest.file_size,
      });
    }
    if (message.voice)
      mediaRefs.push({
        field: 'voice',
        fileId: message.voice.file_id,
        size: message.voice.file_size,
        mime: message.voice.mime_type,
      });
    if (message.audio)
      mediaRefs.push({
        field: 'audio',
        fileId: message.audio.file_id,
        size: message.audio.file_size,
        mime: message.audio.mime_type,
        filename: message.audio.file_name,
      });
    if (message.video)
      mediaRefs.push({
        field: 'video',
        fileId: message.video.file_id,
        size: message.video.file_size,
        mime: message.video.mime_type,
        filename: message.video.file_name,
      });
    if (message.video_note)
      mediaRefs.push({
        field: 'video_note',
        fileId: message.video_note.file_id,
        size: message.video_note.file_size,
      });
    if (message.document)
      mediaRefs.push({
        field: 'document',
        fileId: message.document.file_id,
        size: message.document.file_size,
        mime: message.document.mime_type,
        filename: message.document.file_name,
      });
    if (message.sticker)
      mediaRefs.push({
        field: 'sticker',
        fileId: message.sticker.file_id,
        size: message.sticker.file_size,
        mime: message.sticker.mime_type,
      });

    for (const ref of mediaRefs) {
      if (ref.size && ref.size > MAX_DOWNLOAD_BYTES) {
        this.logger.warn(
          `Skipping Telegram ${ref.field} ${ref.fileId} — ${ref.size} bytes exceeds 20 MB Bot API download limit`,
        );
        continue;
      }
      try {
        const file = await tg.getFile(ref.fileId);
        if (!file.file_path) continue;
        const downloaded = await tg.downloadFile(file.file_path);
        const { r2Kind, dmKind } = this.classifyTelegramMedia(
          ref.field,
          ref.mime ?? downloaded.contentType,
        );
        const filename =
          ref.filename ??
          file.file_path.split('/').pop() ??
          `telegram-${ref.fileId}`;
        const finalContentType = ref.mime ?? downloaded.contentType;
        const { publicUrl } = await this.r2.uploadBuffer({
          kind: r2Kind,
          workspaceId,
          buffer: downloaded.buffer,
          contentType: finalContentType,
          filename,
        });
        rehosted.push({
          kind: dmKind,
          url: publicUrl,
          contentType: finalContentType,
        });
      } catch (err) {
        this.logger.error(
          `Failed to rehost Telegram ${ref.field} ${ref.fileId} for chat ${message.chat.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.inbox.upsertDm({
      workspaceId,
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
      authorAvatarUrl,
      text: resolvedText,
      fromMe: false,
      platformCreatedAt: new Date(message.date * 1000),
      metadata: { chatType: message.chat.type },
      attachments: rehosted.length > 0 ? rehosted : undefined,
    });
  }

  /** Resolve an author's avatar to a durable R2 URL, cheaply.
   *
   *  Resolution order (each step avoids the next, more expensive one):
   *    1. in-memory cache (this process)
   *    2. reuse the avatar URL from a prior ingested message by the same
   *       author on this channel (survives restarts, no Telegram API hit)
   *    3. fetch the profile photo from Telegram → rehost to R2
   *
   *  Best-effort: any failure resolves to null and the UI falls back to an
   *  initials avatar. Never throws — must not block message ingest. */
  private async resolveAuthorAvatar(
    tg: TelegramClient,
    authorId: string,
    workspaceId: string,
    channelId: number,
  ): Promise<string | null> {
    if (this.avatarCache.has(authorId)) {
      return this.avatarCache.get(authorId) ?? null;
    }

    // Step 2 — reuse a previously rehosted avatar for this author.
    try {
      const [prior] = await db
        .select({ url: inboxItems.authorAvatarUrl })
        .from(inboxItems)
        .where(
          and(
            eq(inboxItems.channelId, channelId),
            eq(inboxItems.authorPlatformId, authorId),
            isNotNull(inboxItems.authorAvatarUrl),
          ),
        )
        .orderBy(desc(inboxItems.createdAt))
        .limit(1);
      if (prior?.url) {
        this.avatarCache.set(authorId, prior.url);
        return prior.url;
      }
    } catch (err) {
      this.logger.warn(
        `Avatar DB-reuse lookup failed for author ${authorId}: ${(err as Error).message}`,
      );
    }

    // Step 3 — fetch from Telegram and rehost to R2.
    try {
      const fileId = await tg.getUserProfilePhotoFileId(authorId);
      if (!fileId) {
        this.avatarCache.set(authorId, null);
        return null;
      }
      const file = await tg.getFile(fileId);
      if (!file.file_path) {
        this.avatarCache.set(authorId, null);
        return null;
      }
      const downloaded = await tg.downloadFile(file.file_path);
      const { publicUrl } = await this.r2.uploadBuffer({
        kind: 'image',
        workspaceId,
        buffer: downloaded.buffer,
        contentType: downloaded.contentType,
        filename: `tg-avatar-${authorId}.jpg`,
      });
      this.avatarCache.set(authorId, publicUrl);
      return publicUrl;
    } catch (err) {
      this.logger.warn(
        `Avatar fetch/rehost failed for author ${authorId}: ${(err as Error).message}`,
      );
      this.avatarCache.set(authorId, null);
      return null;
    }
  }

  /** Map a Telegram message media field to our R2 storage kind + the DM
   *  attachment kind the frontend renders. */
  private classifyTelegramMedia(
    field:
      | 'photo'
      | 'voice'
      | 'audio'
      | 'video'
      | 'video_note'
      | 'document'
      | 'sticker',
    mimeType?: string,
  ): {
    r2Kind: R2MediaKind;
    dmKind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  } {
    switch (field) {
      case 'photo':
        return { r2Kind: 'image', dmKind: 'image' };
      case 'voice':
        return { r2Kind: 'voice', dmKind: 'voice' };
      case 'audio':
        return { r2Kind: 'voice', dmKind: 'audio' };
      case 'video':
      case 'video_note':
        return { r2Kind: 'video', dmKind: 'video' };
      case 'document': {
        const mime = (mimeType ?? '').toLowerCase();
        if (mime.startsWith('image/'))
          return { r2Kind: 'image', dmKind: 'image' };
        if (mime.startsWith('video/'))
          return { r2Kind: 'video', dmKind: 'video' };
        if (mime.startsWith('audio/'))
          return { r2Kind: 'voice', dmKind: 'audio' };
        return { r2Kind: 'file', dmKind: 'file' };
      }
      case 'sticker':
        return { r2Kind: 'file', dmKind: 'file' };
    }
  }
}
