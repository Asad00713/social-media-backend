import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { QUEUES } from '../../queue/queue.module';

/** Normalized message shape forwarded to the ingest queue (decoupled from the
 *  discord.js object graph so the ingest processor never imports discord.js). */
interface RawDiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    bot: boolean;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };
  content: string;
  mentions: { id: string }[];
  attachments: {
    id: string;
    url: string;
    filename: string;
    content_type?: string;
  }[];
  referenced_message_id?: string | null;
  timestamp: string;
}

/**
 * Owns the single persistent Discord Gateway (WebSocket) connection for the
 * whole platform. discord.js manages heartbeat / resume / reconnect internally.
 *
 * Receives MESSAGE_CREATE / UPDATE / DELETE, filters to DMs + bot @mentions,
 * and enqueues a normalized payload to DISCORD_INGEST. It never touches the DB,
 * which keeps it thin and trivially extractable into a dedicated worker later.
 *
 * Starts ONLY when `DISCORD_GATEWAY_ENABLED === 'true'` so exactly one running
 * instance opens the connection (Discord disconnects a second IDENTIFY).
 */
@Injectable()
export class DiscordGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordGatewayService.name);
  private client: Client | null = null;
  private botUserId = '';

  constructor(
    @InjectQueue(QUEUES.DISCORD_INGEST) private readonly queue: Queue,
  ) {}

  /** Pure filter: ingest DMs to the bot, or guild messages mentioning the bot.
   *  Never ingest the bot's own messages. */
  shouldIngest(
    msg: {
      guild_id?: string;
      author: { id: string; bot: boolean };
      mentions: { id: string }[];
    },
    botUserId: string,
  ): boolean {
    if (msg.author.bot && msg.author.id === botUserId) return false;
    if (!msg.guild_id) return true; // DM channel
    return msg.mentions.some((m) => m.id === botUserId);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.DISCORD_GATEWAY_ENABLED !== 'true') {
      this.logger.log(
        'DISCORD_GATEWAY_ENABLED!=true — Discord gateway not started on this instance',
      );
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // Required to receive DMs (the DM channel is otherwise uncached).
      partials: [Partials.Channel],
    });

    this.client.once(Events.ClientReady, (c) => {
      this.botUserId = c.user.id;
      this.logger.log(
        `Discord gateway ready as ${c.user.tag} (${c.user.id})`,
      );
    });

    this.client.on(Events.MessageCreate, (m) => {
      void this.forward('create', m);
    });
    this.client.on(Events.MessageUpdate, (_old, m) => {
      void this.forward('update', m);
    });
    this.client.on(Events.MessageDelete, (m) => {
      void this.forwardDelete(m);
    });

    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  private async forward(type: 'create' | 'update', m: any): Promise<void> {
    try {
      const raw = this.toRaw(m);
      if (!this.shouldIngest(raw, this.botUserId)) return;
      await this.queue.add(
        type,
        { type, message: raw },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    } catch (err) {
      this.logger.error(`Failed to forward Discord ${type}: ${String(err)}`);
    }
  }

  private async forwardDelete(m: any): Promise<void> {
    try {
      // Delete events carry minimal data — forward id + channel for lookup.
      await this.queue.add(
        'delete',
        {
          type: 'delete',
          message: {
            id: m.id,
            channel_id: m.channelId,
            guild_id: m.guildId ?? undefined,
          },
        },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    } catch (err) {
      this.logger.error(`Failed to forward Discord delete: ${String(err)}`);
    }
  }

  private toRaw(m: any): RawDiscordMessage {
    const mentionUsers: any[] = m.mentions?.users
      ? [...m.mentions.users.values()]
      : [];
    const attachments: any[] = m.attachments
      ? [...m.attachments.values()]
      : [];
    return {
      id: m.id,
      channel_id: m.channelId,
      guild_id: m.guildId ?? undefined,
      author: {
        id: m.author?.id ?? '',
        bot: Boolean(m.author?.bot),
        username: m.author?.username ?? '',
        global_name: m.author?.globalName ?? null,
        avatar: m.author?.avatar ?? null,
      },
      content: m.content ?? '',
      mentions: mentionUsers.map((u) => ({ id: u.id })),
      attachments: attachments.map((a) => ({
        id: a.id,
        url: a.url,
        filename: a.name,
        content_type: a.contentType ?? undefined,
      })),
      referenced_message_id: m.reference?.messageId ?? null,
      timestamp: (m.createdAt ?? new Date()).toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.destroy();
  }
}
