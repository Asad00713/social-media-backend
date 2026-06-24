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
      'channels:join',
      'channels:manage',
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'im:write',
      'mpim:write',
      'groups:write',
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

  /** List all public + private channels the bot can see, with pagination cursor.
   *  We surface `is_member` so the UI can show a Join button on rows the bot
   *  isn't in yet. */
  async listAllChannels(
    botToken: string,
    options: { cursor?: string; limit?: number; includePrivate?: boolean } = {},
  ) {
    const client = new WebClient(botToken);
    const types = options.includePrivate
      ? 'public_channel,private_channel'
      : 'public_channel';
    const res = await client.conversations.list({
      types,
      limit: options.limit ?? 100,
      cursor: options.cursor,
      exclude_archived: true,
    });
    if (!res.ok)
      throw new BadRequestException(`conversations.list failed: ${res.error}`);
    return {
      channels: (res.channels ?? []).map((c) => ({
        id: c.id!,
        name: c.name ?? '',
        isMember: c.is_member ?? false,
        isPrivate: c.is_private ?? false,
        numMembers: c.num_members ?? 0,
        topic: c.topic?.value ?? null,
        purpose: c.purpose?.value ?? null,
      })),
      nextCursor: res.response_metadata?.next_cursor || null,
    };
  }

  /** Paginated workspace members. Filters out bots and deactivated users.
   *  Pass a `query` to narrow by name (case-insensitive substring on real_name/name). */
  async listMembers(
    botToken: string,
    options: { cursor?: string; limit?: number; query?: string } = {},
  ) {
    const client = new WebClient(botToken);
    const res = await client.users.list({
      limit: options.limit ?? 200,
      cursor: options.cursor,
    });
    if (!res.ok)
      throw new BadRequestException(`users.list failed: ${res.error}`);
    const filtered = (res.members ?? []).filter(
      (u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT',
    );
    const q = options.query?.trim().toLowerCase();
    const matched = q
      ? filtered.filter((u) => {
          const name = (u.real_name ?? u.name ?? '').toLowerCase();
          const handle = (u.name ?? '').toLowerCase();
          return name.includes(q) || handle.includes(q);
        })
      : filtered;
    return {
      members: matched.map((u) => ({
        id: u.id!,
        handle: u.name ?? null,
        displayName: u.real_name ?? u.name ?? null,
        avatarUrl: u.profile?.image_192 ?? null,
        email: u.profile?.email ?? null,
        isAdmin: u.is_admin ?? false,
      })),
      nextCursor: res.response_metadata?.next_cursor || null,
    };
  }

  /** Open a DM channel with a specific user. */
  async openDm(botToken: string, userId: string): Promise<string> {
    const client = new WebClient(botToken);
    const res = await client.conversations.open({ users: userId });
    if (!res.ok || !res.channel?.id)
      throw new BadRequestException(`conversations.open failed: ${res.error}`);
    return res.channel.id;
  }

  /** Open a DM with a user and send the first message in one call. */
  async openDmAndSendFirst(
    botToken: string,
    userId: string,
    text: string,
  ): Promise<{ conversationId: string; ts: string }> {
    const conversationId = await this.openDm(botToken, userId);
    const res = await this.postMessage(botToken, {
      channel: conversationId,
      text,
    });
    return { conversationId, ts: res.ts };
  }

  /** Bot self-joins a public channel so it can read history + receive events. */
  async joinChannel(
    botToken: string,
    channelId: string,
  ): Promise<{ already_in_channel?: boolean }> {
    const client = new WebClient(botToken);
    const res = await client.conversations.join({ channel: channelId });
    if (!res.ok) {
      // Slack returns method_not_supported_for_channel_type for IMs/MPIMs/private channels.
      throw new BadRequestException(`conversations.join failed: ${res.error}`);
    }
    return {
      already_in_channel: (res as any).already_in_channel as
        | boolean
        | undefined,
    };
  }

  /** Create a new channel. Bot becomes a member automatically as the creator.
   *  Returns the new conversation id + name. */
  async createChannel(
    botToken: string,
    options: { name: string; isPrivate?: boolean; purpose?: string },
  ): Promise<{ id: string; name: string }> {
    const client = new WebClient(botToken);
    const res = await client.conversations.create({
      name: options.name,
      is_private: options.isPrivate ?? false,
    });
    if (!res.ok || !res.channel?.id) {
      throw new BadRequestException(
        `conversations.create failed: ${res.error ?? 'unknown'}`,
      );
    }
    // Set purpose separately (optional)
    if (options.purpose) {
      await client.conversations
        .setPurpose({
          channel: res.channel.id,
          purpose: options.purpose,
        })
        .catch(() => null);
    }
    return {
      id: res.channel.id,
      name: (res.channel as any).name ?? options.name,
    };
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

  /** Resolve Slack's raw message markup to a human-readable string.
   *  Handles:
   *   - User mentions: `<@U0B91QB557S>`        → `@displayName`
   *   - Channel refs:  `<#C0123|general>`      → `#general`
   *   - URLs w/ label: `<https://x.com|click>` → `click`
   *   - Bare URLs:     `<https://x.com>`       → `https://x.com`
   *
   *  We cache user lookups within the call so a single message with multiple
   *  mentions doesn't fire one users.info per occurrence. */
  async resolveSlackMentions(botToken: string, text: string): Promise<string> {
    if (!text) return text;

    // 1. User mentions
    const userIds = Array.from(
      new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1])),
    );
    const userMap = new Map<string, string>();
    await Promise.all(
      userIds.map(async (id) => {
        const info = await this.getUserInfo(botToken, id).catch(() => null);
        if (info) {
          userMap.set(id, info.displayName ?? info.handle ?? id);
        }
      }),
    );

    let resolved = text.replace(/<@([UW][A-Z0-9]+)>/g, (_, id: string) => {
      const name = userMap.get(id);
      return name ? `@${name}` : `@${id}`;
    });

    // 2. Channel refs — `<#CID|name>` or `<#CID>`
    resolved = resolved.replace(
      /<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g,
      (_, _id: string, name?: string) => (name ? `#${name}` : `#channel`),
    );

    // 3. URLs with optional label — `<https://x|y>` or `<https://x>`
    resolved = resolved.replace(
      /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g,
      (_, url: string, label?: string) => label ?? url,
    );

    return resolved;
  }

  /** Download a Slack-hosted file using the bot token. `url_private_download`
   *  works the same as `url_private` but forces a Content-Disposition: attachment
   *  response, which is what we want for arbitrary blobs. */
  async downloadFile(
    botToken: string,
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string; sizeBytes: number }> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Slack file download failed: ${res.status} ${res.statusText}`,
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    return { buffer, contentType, sizeBytes: buffer.length };
  }

  /** Upload a file to a Slack channel using files.uploadV2 (handles the
   *  getUploadURLExternal → PUT → completeUploadExternal flow internally).
   *  Pass `initialComment` to attach the message text as the file's caption. */
  async uploadFile(
    botToken: string,
    input: {
      channelId: string;
      filename: string;
      contentType: string;
      buffer: Buffer;
      initialComment?: string;
      threadTs?: string;
    },
  ): Promise<{ fileId: string }> {
    const client = new WebClient(botToken);
    let res: Awaited<ReturnType<typeof client.files.uploadV2>>;
    try {
      res = await client.files.uploadV2({
        channel_id: input.channelId,
        filename: input.filename,
        file: input.buffer,
        initial_comment: input.initialComment,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      } as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new BadRequestException(`files.uploadV2 failed: ${msg}`);
    }
    // uploadV2 (SDK v7) returns a DOUBLE-nested shape:
    //   { files: [ { ok, files: [ { id, ... } ] } ] }
    // The outer `files[]` is one FilesCompleteUploadExternalResponse per
    // upload; the real file object (with `id`) lives in its inner `files[]`.
    // Reading `files[0].id` lands on the wrapper (no `id`) → false "no file
    // id" error even though the upload succeeded. Read the nested id first,
    // keep flatter shapes as fallbacks for older/edge responses.
    const fileId =
      (res as any).files?.[0]?.files?.[0]?.id ??
      (res as any).files?.[0]?.id ??
      (res as any).file?.id;
    if (!fileId) {
      throw new BadRequestException(
        'files.uploadV2 succeeded but returned no file id',
      );
    }
    return { fileId: String(fileId) };
  }

  /** Delete a message the bot posted via chat.postMessage. `ts` is the Slack
   *  message timestamp. Slack only permits a bot to delete its own messages,
   *  and (unlike FB Messenger) imposes no time window. Requires `chat:write`. */
  async deleteMessage(
    botToken: string,
    channel: string,
    ts: string,
  ): Promise<boolean> {
    const client = new WebClient(botToken);
    const res = await client.chat.delete({ channel, ts });
    if (!res.ok) {
      throw new BadRequestException(`chat.delete failed: ${res.error}`);
    }
    return true;
  }

  /** Delete a file the bot uploaded via files.uploadV2. Slack has no
   *  per-share delete, so this unshares the file from EVERY channel it was
   *  posted to. We rely on it for attachment DMs because uploadV2 returns no
   *  message `ts` to target with chat.delete. Requires `files:write`. */
  async deleteFile(botToken: string, fileId: string): Promise<boolean> {
    const client = new WebClient(botToken);
    const res = await client.files.delete({ file: fileId });
    if (!res.ok) {
      throw new BadRequestException(`files.delete failed: ${res.error}`);
    }
    return true;
  }
}
