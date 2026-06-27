import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  ApplicationCommandOptionType,
  MessageFlags,
} from 'discord.js';
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
  /** When true, ingest ALL guild channel messages (not just @mentions). Requires
   *  the privileged Message Content intent enabled in the Discord Developer Portal. */
  private ingestChannelMessages = false;

  constructor(
    @InjectQueue(QUEUES.DISCORD_INGEST) private readonly queue: Queue,
  ) {}

  /** Pure filter: ingest DMs to the bot, or guild messages mentioning the bot.
   *  When `ingestAllGuildMessages` is on, ingest every guild channel message.
   *  Never ingest the bot's own messages. */
  shouldIngest(
    msg: {
      guild_id?: string;
      author: { id: string; bot: boolean };
      mentions: { id: string }[];
    },
    botUserId: string,
    ingestAllGuildMessages = false,
  ): boolean {
    if (msg.author.bot && msg.author.id === botUserId) return false;
    if (!msg.guild_id) return true; // DM channel
    if (ingestAllGuildMessages) return true; // every channel message
    return msg.mentions.some((m) => m.id === botUserId);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.DISCORD_GATEWAY_ENABLED !== 'true') {
      this.logger.log(
        'DISCORD_GATEWAY_ENABLED!=true — Discord gateway not started on this instance',
      );
      return;
    }

    // DMs + @mentions work WITHOUT the privileged Message Content intent (Discord
    // exempts them). To ingest ALL channel messages we additionally request the
    // MessageContent intent — gated behind DISCORD_INGEST_CHANNEL_MESSAGES so the
    // bot never requests a disallowed intent (which fails login) unless the Portal
    // toggle is on. Enable order: Portal "Message Content Intent" ON → set the env
    // flag → restart. (At 100+ servers Discord requires review for this intent.)
    this.ingestChannelMessages =
      process.env.DISCORD_INGEST_CHANNEL_MESSAGES === 'true';

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ];
    if (this.ingestChannelMessages) {
      intents.push(GatewayIntentBits.MessageContent);
      this.logger.log(
        'DISCORD_INGEST_CHANNEL_MESSAGES=true — requesting MessageContent intent (all channel messages will be ingested)',
      );
    }

    this.client = new Client({
      intents,
      // Required to receive DMs (the DM channel is otherwise uncached).
      partials: [Partials.Channel],
    });

    this.client.once(Events.ClientReady, (c) => {
      this.botUserId = c.user.id;
      this.logger.log(`Discord gateway ready as ${c.user.tag} (${c.user.id})`);
      // Register the /ask command in every guild the bot is already in.
      // Guild-scoped commands appear instantly (global ones take up to 1h).
      for (const [guildId] of c.guilds.cache) {
        void this.registerAskCommand(guildId);
      }
    });

    // Register /ask for any guild the bot is added to after startup.
    this.client.on(Events.GuildCreate, (g) => {
      void this.registerAskCommand(g.id);
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
    this.client.on(Events.InteractionCreate, (i) => {
      void this.handleInteraction(i);
    });

    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  /** Register the /ask slash command for a guild (idempotent — Discord upserts
   *  by name). Gives community members a discoverable way to message the team;
   *  the question lands in the Schedura inbox as a DM conversation. */
  private async registerAskCommand(guildId: string): Promise<void> {
    try {
      await this.client?.application?.commands.create(
        {
          name: 'ask',
          description: 'Send a question or message to the team',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'message',
              description: 'Your question or message',
              required: true,
            },
          ],
        },
        guildId,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to register /ask in guild ${guildId}: ${String(err)}`,
      );
    }
  }

  /** Handle a /ask interaction: acknowledge within Discord's 3s window, then
   *  enqueue the question for the ingest processor to thread into the inbox. */
  private async handleInteraction(interaction: any): Promise<void> {
    try {
      if (
        !interaction.isChatInputCommand?.() ||
        interaction.commandName !== 'ask'
      ) {
        return;
      }
      const message: string = interaction.options.getString('message') ?? '';

      // Acknowledge privately so the member knows it was received.
      await interaction.reply({
        content:
          'Thanks! Your message has reached the team — they will reply to you here in a DM.',
        flags: MessageFlags.Ephemeral,
      });

      const user = interaction.user;
      await this.queue.add(
        'ask',
        {
          type: 'ask',
          message: {
            guild_id: interaction.guildId,
            interaction_id: interaction.id,
            text: message,
            author: {
              id: user.id,
              bot: Boolean(user.bot),
              username: user.username,
              global_name: user.globalName ?? null,
              avatar: user.avatar ?? null,
            },
          },
        },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    } catch (err) {
      this.logger.error(`Failed to handle /ask interaction: ${String(err)}`);
    }
  }

  private async forward(type: 'create' | 'update', m: any): Promise<void> {
    try {
      const raw = this.toRaw(m);
      if (!this.shouldIngest(raw, this.botUserId, this.ingestChannelMessages))
        return;
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
    const attachments: any[] = m.attachments ? [...m.attachments.values()] : [];
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
