import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import { DiscordService } from '../../channels/services/discord.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { R2MediaKind } from '../../media/cloudflare-r2.service';

/** Map a Discord attachment content-type to our R2 storage kind + the DM
 *  attachment kind the inbox UI renders. */
export function classifyDiscordAttachment(contentType?: string): {
  r2Kind: R2MediaKind;
  dmKind: 'image' | 'video' | 'audio' | 'voice' | 'file';
} {
  const mime = (contentType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return { r2Kind: 'image', dmKind: 'image' };
  if (mime.startsWith('video/')) return { r2Kind: 'video', dmKind: 'video' };
  if (mime.startsWith('audio/')) return { r2Kind: 'voice', dmKind: 'voice' };
  return { r2Kind: 'file', dmKind: 'file' };
}

/**
 * Consumes `DISCORD_INGEST` jobs enqueued by `DiscordGatewayService`.
 *
 * Phase 1 handles:
 *   - `create` / `update` → upsert the message into `inbox_items`. (Discord's
 *     own text edits are not separately reflected — consistent with Slack /
 *     Telegram which treat ingested messages as immutable. `update` is a safe
 *     no-op for text via the upsert.)
 *   - `delete` → soft-delete the matching row.
 *
 * Discord uses the single shared bot token (via `DiscordService`) for all REST
 * calls, so there is no per-channel token to decrypt here.
 */
@Processor(QUEUES.DISCORD_INGEST)
export class DiscordIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(DiscordIngestProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly discord: DiscordService,
    private readonly r2: CloudflareR2Service,
  ) {
    super();
  }

  async process(
    job: Job<{ type: 'create' | 'update' | 'delete' | 'ask'; message: any }>,
  ): Promise<void> {
    const { type, message: msg } = job.data;

    const channels = await this.resolveChannels(msg.guild_id);
    if (channels.length === 0) {
      this.logger.warn(
        `No Discord channel row for guild ${msg.guild_id ?? '(dm)'} — skipping`,
      );
      return;
    }

    // Fan out to EVERY workspace this guild is connected to (a guild can be
    // linked by more than one workspace); a single-row lookup would drop the
    // message for the others.
    for (const channel of channels) {
      await this.ingestForChannel(channel, type, msg);
    }
  }

  /** Ingest one Discord gateway event into a single channel/workspace. Called
   *  once per matching channel by {@link process}. */
  private async ingestForChannel(
    channel: { id: number; workspaceId: string },
    type: 'create' | 'update' | 'delete' | 'ask',
    msg: any,
  ): Promise<void> {
    if (type === 'delete') {
      await this.inbox.softDeleteDmByPlatformItemId({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platformItemId: msg.id,
      });
      return;
    }

    // `/ask` slash command — open a DM channel with the asker so the question
    // and the team's replies thread as a normal DM conversation, then ingest
    // the question as the first inbound message. Replies sent from the inbox go
    // back to the member via that DM channel (DiscordDmAdapter.sendDm).
    if (type === 'ask') {
      const asker = msg.author ?? {};
      const dmChannelId = await this.discord.openDmChannel(asker.id);
      await this.inbox.upsertDm({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'discord',
        conversationId: dmChannelId,
        platformItemId: msg.interaction_id,
        authorPlatformId: asker.id ?? null,
        authorHandle: asker.username ?? null,
        authorDisplayName: asker.global_name ?? asker.username ?? null,
        authorAvatarUrl: this.discord.avatarUrl(asker.id, asker.avatar ?? null),
        text: msg.text ?? '',
        fromMe: false,
        platformCreatedAt: new Date(),
        metadata: { guildId: msg.guild_id ?? null, source: 'slash:ask' },
      });
      return;
    }

    const author = msg.author ?? {};
    const avatarUrl = this.discord.avatarUrl(author.id, author.avatar ?? null);

    // Rehost attachments to R2 for permanence + consistency with other
    // platforms. Per-file failure logs + drops that file only, never the message.
    const rehosted: {
      kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
      url: string;
      contentType?: string;
    }[] = [];
    const rawAttachments: any[] = Array.isArray(msg.attachments)
      ? msg.attachments
      : [];
    for (const a of rawAttachments) {
      try {
        const { buffer, contentType } = await this.discord.downloadAttachment(
          a.url,
        );
        const finalType = a.content_type ?? contentType;
        const { r2Kind, dmKind } = classifyDiscordAttachment(finalType);
        const { publicUrl } = await this.r2.uploadBuffer({
          kind: r2Kind,
          workspaceId: channel.workspaceId,
          buffer,
          contentType: finalType,
          filename: a.filename ?? `discord-${a.id}`,
        });
        rehosted.push({ kind: dmKind, url: publicUrl, contentType: finalType });
      } catch (err) {
        this.logger.error(
          `Failed to rehost Discord attachment ${a.id ?? '?'}: ${String(err)}`,
        );
      }
    }

    await this.inbox.upsertDm({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      platform: 'discord',
      conversationId: msg.channel_id,
      platformItemId: msg.id,
      platformParentId: msg.referenced_message_id ?? null,
      authorPlatformId: author.id ?? null,
      authorHandle: author.username ?? null,
      authorDisplayName: author.global_name ?? author.username ?? null,
      authorAvatarUrl: avatarUrl,
      text: msg.content ?? '',
      fromMe: false,
      platformCreatedAt: new Date(msg.timestamp),
      metadata: { guildId: msg.guild_id ?? null },
      attachments: rehosted.length > 0 ? rehosted : undefined,
    });
  }

  /** Resolve the Schedura channel rows for an event. Guild messages fan out to
   *  EVERY channel mapped to `guild_id`; DMs (no guild) can't be attributed to a
   *  specific workspace with a shared bot, so they keep the Phase-1 behaviour of
   *  the most-recently-connected Discord channel as a single-element list (proper
   *  per-workspace DM routing needs per-workspace bots — tracked separately). */
  private async resolveChannels(guildId?: string) {
    if (guildId) {
      return db
        .select()
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.platform, 'discord'),
            eq(socialMediaChannels.platformAccountId, guildId),
          ),
        );
    }
    const [c] = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.platform, 'discord'))
      .orderBy(desc(socialMediaChannels.id))
      .limit(1);
    return c ? [c] : [];
  }
}
