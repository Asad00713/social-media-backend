import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { WebClient } from '@slack/web-api';

interface SlackOAuthResult {
  ok: boolean;
  app_id: string;
  authed_user: { id: string };
  scope: string;
  token_type: 'bot';
  access_token: string; // xoxb-...
  bot_user_id: string;
  team: { id: string; name: string };
  enterprise: { id: string; name: string } | null;
  is_enterprise_install: boolean;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  private readonly clientId = process.env.SLACK_CLIENT_ID!;
  private readonly clientSecret = process.env.SLACK_CLIENT_SECRET!;

  /** Build the consent URL for the Connect Slack button. */
  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const scopes = [
      'app_mentions:read',
      'chat:write',
      'chat:write.public',
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'users:read',
      'team:read',
      'files:write',
    ].join(',');
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Exchange the OAuth `code` for a bot token + workspace metadata. */
  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<SlackOAuthResult> {
    const client = new WebClient();
    const res = await client.oauth.v2.access({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    if (!res.ok || !res.access_token) {
      throw new BadRequestException(
        `Slack OAuth failed: ${res.error ?? 'unknown'}`,
      );
    }
    return res as unknown as SlackOAuthResult;
  }

  /** Fetch the bot's own user profile — used for display name + avatar on
   *  the channels card. */
  async getBotProfile(botToken: string, botUserId: string) {
    const client = new WebClient(botToken);
    const res = await client.users.info({ user: botUserId });
    if (!res.ok || !res.user)
      throw new BadRequestException(`users.info failed: ${res.error}`);
    return {
      id: res.user.id,
      name: res.user.real_name ?? res.user.name ?? 'Schedura Bot',
      avatar: res.user.profile?.image_192 ?? null,
    };
  }

  /** Send a message into a channel (or DM). `threadTs` opts into thread reply. */
  async postMessage(
    botToken: string,
    input: { channel: string; text: string; threadTs?: string },
  ) {
    const client = new WebClient(botToken);
    const res = await client.chat.postMessage({
      channel: input.channel,
      text: input.text,
      thread_ts: input.threadTs,
    });
    if (!res.ok)
      throw new BadRequestException(`chat.postMessage failed: ${res.error}`);
    return { ts: res.ts!, channel: res.channel! };
  }

  /** Fetch recent history of a channel for backfill on connect. */
  async getChannelHistory(
    botToken: string,
    channel: string,
    options: { oldest?: string; limit?: number } = {},
  ) {
    const client = new WebClient(botToken);
    const res = await client.conversations.history({
      channel,
      oldest: options.oldest,
      limit: options.limit ?? 50,
    });
    if (!res.ok)
      throw new BadRequestException(
        `conversations.history failed: ${res.error}`,
      );
    return res.messages ?? [];
  }

  /** List conversations the bot is a member of — for the inbox list. */
  async listConversations(botToken: string) {
    const client = new WebClient(botToken);
    const res = await client.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      limit: 200,
    });
    if (!res.ok)
      throw new BadRequestException(`conversations.list failed: ${res.error}`);
    return res.channels ?? [];
  }

  /** Open a DM channel with a specific user. */
  async openDm(botToken: string, userId: string): Promise<string> {
    const client = new WebClient(botToken);
    const res = await client.conversations.open({ users: userId });
    if (!res.ok || !res.channel?.id)
      throw new BadRequestException(
        `conversations.open failed: ${res.error}`,
      );
    return res.channel.id;
  }

  /** Look up a user's profile by Slack user id — populates author handle /
   *  display name when ingesting incoming messages. */
  async getUserInfo(botToken: string, userId: string) {
    const client = new WebClient(botToken);
    const res = await client.users.info({ user: userId });
    if (!res.ok || !res.user) return null;
    return {
      id: res.user.id,
      handle: res.user.name ?? null,
      displayName: res.user.real_name ?? null,
      avatarUrl: res.user.profile?.image_192 ?? null,
    };
  }
}
