import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { REST, Routes } from 'discord.js';

/**
 * Discord REST client (uses the single shared bot token). Handles the OUTBOUND
 * surface for the Discord inbox: create/delete messages, fetch user profiles,
 * download attachments, and the bot-invite OAuth code exchange.
 *
 * The persistent Gateway connection lives in DiscordGatewayService — this
 * service is stateless request/response only.
 */
@Injectable()
export class DiscordService {
  private readonly logger = new Logger(DiscordService.name);
  private readonly rest = new REST({ version: '10' }).setToken(
    process.env.DISCORD_BOT_TOKEN ?? '',
  );

  /** Build a CDN avatar URL, or null when the user has no custom avatar. */
  avatarUrl(userId: string, avatarHash: string | null): string | null {
    if (!avatarHash) return null;
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
  }

  /** Create a message in a channel (DM or guild). `messageReferenceId` makes it
   *  a reply. `files` are uploaded as attachments. */
  async createMessage(
    channelId: string,
    body: {
      content?: string;
      messageReferenceId?: string;
      files?: { name: string; data: Buffer; contentType?: string }[];
    },
  ): Promise<{ id: string; channelId: string }> {
    const payload: Record<string, any> = {};
    if (body.content) payload.content = body.content;
    if (body.messageReferenceId) {
      payload.message_reference = { message_id: body.messageReferenceId };
    }
    const res = (await this.rest.post(Routes.channelMessages(channelId), {
      body: payload,
      files: body.files?.map((f) => ({
        name: f.name,
        data: f.data,
        contentType: f.contentType,
      })),
    })) as { id: string; channel_id: string };
    return { id: res.id, channelId: res.channel_id };
  }

  /** Delete a message the bot authored. Returns true on success. */
  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    await this.rest.delete(Routes.channelMessage(channelId, messageId));
    return true;
  }

  /** Open (or fetch the existing) DM channel with a user. Used by the `/ask`
   *  slash command so the question + the team's replies thread as a normal DM
   *  conversation. Works because the user shares a guild with the bot. Returns
   *  the DM channel id (used as the inbox conversationId). */
  async openDmChannel(userId: string): Promise<string> {
    const dm = (await this.rest.post(Routes.userChannels(), {
      body: { recipient_id: userId },
    })) as { id: string };
    return dm.id;
  }

  /** List the TEXT channels of a guild the bot is in (type 0 = GUILD_TEXT,
   *  type 5 = GUILD_ANNOUNCEMENT — both accept messages). Used by the compose
   *  surface to let the user pick where to post. */
  async listGuildChannels(
    guildId: string,
  ): Promise<{ id: string; name: string; type: number }[]> {
    const channels = (await this.rest.get(Routes.guildChannels(guildId))) as {
      id: string;
      name: string;
      type: number;
    }[];
    return channels
      .filter((c) => c.type === 0 || c.type === 5)
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
  }

  /** Create a new text channel in a guild. Requires the bot to have the
   *  MANAGE_CHANNELS permission (granted at invite time via the permissions
   *  bitfield — existing bots must reconnect to gain it). */
  async createGuildChannel(
    guildId: string,
    name: string,
  ): Promise<{ id: string; name: string }> {
    const created = (await this.rest.post(Routes.guildChannels(guildId), {
      body: { name, type: 0 },
    })) as { id: string; name: string };
    return { id: created.id, name: created.name };
  }

  /** Fetch a user's public profile for inbox author display. */
  async getUser(userId: string): Promise<{
    id: string;
    username: string;
    globalName: string | null;
    avatarUrl: string | null;
  } | null> {
    try {
      const u = (await this.rest.get(Routes.user(userId))) as {
        id: string;
        username: string;
        global_name: string | null;
        avatar: string | null;
      };
      return {
        id: u.id,
        username: u.username,
        globalName: u.global_name,
        avatarUrl: this.avatarUrl(u.id, u.avatar),
      };
    } catch (err) {
      this.logger.warn(`getUser failed for ${userId}: ${String(err)}`);
      return null;
    }
  }

  /** Download a Discord-hosted attachment (CDN urls are public + unauth). */
  async downloadAttachment(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new BadRequestException(`Discord attachment fetch ${res.status}`);
    }
    const contentType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ??
      'application/octet-stream';
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  }

  /** Exchange the bot-invite OAuth code for the guild the bot was added to.
   *  The token response carries the full `guild` object (id/name/icon) so we
   *  can label the channel without a follow-up REST call. */
  async exchangeOAuthCode(
    code: string,
    redirectUri: string,
  ): Promise<{
    guildId: string;
    guildName: string | null;
    guildIconUrl: string | null;
    accessToken: string;
  }> {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID ?? '',
      client_secret: process.env.DISCORD_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      guild?: { id?: string; name?: string; icon?: string | null };
    };
    const guild = data.guild;
    if (!res.ok || !guild?.id) {
      throw new BadRequestException('Discord OAuth exchange failed');
    }
    return {
      guildId: guild.id,
      guildName: guild.name ?? null,
      guildIconUrl: guild.icon
        ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
        : null,
      accessToken: data.access_token ?? '',
    };
  }
}
