import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  ResolvedChannel,
} from '../../inbox/adapters/inbox-adapter.interface';

export interface MastodonApp {
  id: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  instanceUrl: string;
}

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string; // username@instance for remote, username for local
  displayName: string;
  avatar: string;
  header: string;
  followersCount: number;
  followingCount: number;
  statusesCount: number;
  note: string; // Bio in HTML
  url: string;
}

export interface MastodonStatus {
  id: string;
  uri: string;
  url: string;
  content: string;
  createdAt: string;
  reblogsCount: number;
  favouritesCount: number;
  repliesCount: number;
}

export interface MastodonMediaAttachment {
  id: string;
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown';
  url: string;
  previewUrl: string;
}

@Injectable()
export class MastodonService {
  private readonly logger = new Logger(MastodonService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Normalize instance URL (ensure https:// and no trailing slash)
   */
  private normalizeInstanceUrl(instanceUrl: string): string {
    let url = instanceUrl.trim().toLowerCase();

    // Add https:// if no protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    // Remove trailing slash
    url = url.replace(/\/+$/, '');

    return url;
  }

  /**
   * Register the application with a Mastodon instance
   * This needs to be done once per instance
   */
  async registerApp(
    instanceUrl: string,
    redirectUri: string,
    appName: string = 'Schedura',
  ): Promise<MastodonApp> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(`${normalizedUrl}/api/v1/apps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_name: appName,
        redirect_uris: redirectUri,
        scopes: 'read write follow',
        website: this.configService.get<string>('APP_URL') || 'https://schedura.com',
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to register Mastodon app: ${errorData}`);
      throw new BadRequestException(`Failed to register app with Mastodon instance: ${errorData}`);
    }

    const data = await response.json();

    return {
      id: data.id,
      clientId: data.client_id,
      clientSecret: data.client_secret,
      redirectUri,
      instanceUrl: normalizedUrl,
    };
  }

  /**
   * Generate the OAuth authorization URL
   */
  getAuthorizationUrl(
    instanceUrl: string,
    clientId: string,
    redirectUri: string,
    state: string,
  ): string {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);
    const url = new URL(`${normalizedUrl}/oauth/authorize`);

    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'read write follow');
    url.searchParams.set('state', state);

    return url.toString();
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    instanceUrl: string,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; tokenType: string; scope: string; createdAt: number }> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(`${normalizedUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code,
        scope: 'read write follow',
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to exchange code for token: ${errorData}`);
      throw new BadRequestException(`Failed to authenticate with Mastodon: ${errorData}`);
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope,
      createdAt: data.created_at,
    };
  }

  /**
   * Verify credentials and get account info
   */
  async verifyCredentials(
    instanceUrl: string,
    accessToken: string,
  ): Promise<MastodonAccount> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(
      `${normalizedUrl}/api/v1/accounts/verify_credentials`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to verify Mastodon credentials: ${errorData}`);
      throw new BadRequestException('Failed to verify Mastodon credentials');
    }

    const data = await response.json();

    return {
      id: data.id,
      username: data.username,
      acct: data.acct,
      displayName: data.display_name || data.username,
      avatar: data.avatar,
      header: data.header,
      followersCount: data.followers_count,
      followingCount: data.following_count,
      statusesCount: data.statuses_count,
      note: data.note,
      url: data.url,
    };
  }

  /**
   * Get account info by ID
   */
  async getAccount(
    instanceUrl: string,
    accessToken: string,
    accountId: string,
  ): Promise<MastodonAccount> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(
      `${normalizedUrl}/api/v1/accounts/${accountId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Mastodon account: ${errorData}`);
      throw new BadRequestException('Failed to get Mastodon account');
    }

    const data = await response.json();

    return {
      id: data.id,
      username: data.username,
      acct: data.acct,
      displayName: data.display_name || data.username,
      avatar: data.avatar,
      header: data.header,
      followersCount: data.followers_count,
      followingCount: data.following_count,
      statusesCount: data.statuses_count,
      note: data.note,
      url: data.url,
    };
  }

  /**
   * Create a text-only status (toot)
   */
  async createStatus(
    instanceUrl: string,
    accessToken: string,
    status: string,
    options?: {
      inReplyToId?: string;
      sensitive?: boolean;
      spoilerText?: string;
      visibility?: 'public' | 'unlisted' | 'private' | 'direct';
      language?: string;
      scheduledAt?: string; // ISO 8601 datetime
      mediaIds?: string[];
    },
  ): Promise<MastodonStatus> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const body: Record<string, any> = {
      status,
    };

    if (options?.inReplyToId) body.in_reply_to_id = options.inReplyToId;
    if (options?.sensitive !== undefined) body.sensitive = options.sensitive;
    if (options?.spoilerText) body.spoiler_text = options.spoilerText;
    if (options?.visibility) body.visibility = options.visibility;
    if (options?.language) body.language = options.language;
    if (options?.scheduledAt) body.scheduled_at = options.scheduledAt;
    if (options?.mediaIds && options.mediaIds.length > 0) {
      body.media_ids = options.mediaIds;
    }

    const response = await fetch(`${normalizedUrl}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create Mastodon status: ${errorData}`);
      throw new BadRequestException(`Failed to create post on Mastodon: ${errorData}`);
    }

    const data = await response.json();

    return {
      id: data.id,
      uri: data.uri,
      url: data.url,
      content: data.content,
      createdAt: data.created_at,
      reblogsCount: data.reblogs_count || 0,
      favouritesCount: data.favourites_count || 0,
      repliesCount: data.replies_count || 0,
    };
  }

  /**
   * Upload media attachment
   */
  async uploadMedia(
    instanceUrl: string,
    accessToken: string,
    mediaUrl: string,
    description?: string,
  ): Promise<MastodonMediaAttachment> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    // Download the media from URL
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      throw new BadRequestException(`Failed to fetch media: ${mediaUrl}`);
    }

    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
    const mimeType = mediaResponse.headers.get('content-type') || 'application/octet-stream';

    // Determine filename from URL or use default
    const urlParts = mediaUrl.split('/');
    const filename = urlParts[urlParts.length - 1].split('?')[0] || 'media';

    // Create form data
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const parts: (string | Buffer)[] = [];

    // Add file field
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
    parts.push(`Content-Type: ${mimeType}\r\n\r\n`);
    parts.push(mediaBuffer);
    parts.push('\r\n');

    // Add description if provided
    if (description) {
      parts.push(`--${boundary}\r\n`);
      parts.push(`Content-Disposition: form-data; name="description"\r\n\r\n`);
      parts.push(`${description}\r\n`);
    }

    parts.push(`--${boundary}--\r\n`);

    // Combine all parts into a single buffer
    const bodyParts = parts.map(part =>
      typeof part === 'string' ? Buffer.from(part, 'utf-8') : part
    );
    const body = Buffer.concat(bodyParts);

    const response = await fetch(`${normalizedUrl}/api/v2/media`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body as unknown as BodyInit,
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload Mastodon media: ${errorData}`);
      throw new BadRequestException(`Failed to upload media to Mastodon: ${errorData}`);
    }

    const data = await response.json();

    // If status is 202, media is still processing - poll for completion
    if (response.status === 202) {
      return this.waitForMediaProcessing(normalizedUrl, accessToken, data.id);
    }

    return {
      id: data.id,
      type: data.type,
      url: data.url,
      previewUrl: data.preview_url,
    };
  }

  /**
   * Wait for media to finish processing
   */
  private async waitForMediaProcessing(
    instanceUrl: string,
    accessToken: string,
    mediaId: string,
    maxAttempts: number = 30,
  ): Promise<MastodonMediaAttachment> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(`${instanceUrl}/api/v1/media/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.status === 200) {
        const data = await response.json();
        return {
          id: data.id,
          type: data.type,
          url: data.url,
          previewUrl: data.preview_url,
        };
      }

      if (response.status !== 206) {
        // 206 means still processing
        const errorData = await response.text();
        throw new BadRequestException(`Media processing failed: ${errorData}`);
      }

      // Wait 2 seconds before next attempt
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new BadRequestException('Media processing timed out');
  }

  /**
   * Create a post with images
   */
  async createImagePost(
    instanceUrl: string,
    accessToken: string,
    text: string,
    imageUrls: string[],
    altTexts?: string[],
    visibility?: 'public' | 'unlisted' | 'private' | 'direct',
  ): Promise<MastodonStatus> {
    // Upload all images first
    const mediaIds: string[] = [];

    for (let i = 0; i < imageUrls.length && i < 4; i++) {
      const altText = altTexts?.[i];
      const media = await this.uploadMedia(instanceUrl, accessToken, imageUrls[i], altText);
      mediaIds.push(media.id);
    }

    // Create status with media
    return this.createStatus(instanceUrl, accessToken, text, {
      mediaIds,
      visibility,
    });
  }

  /**
   * Create a post with video
   */
  async createVideoPost(
    instanceUrl: string,
    accessToken: string,
    text: string,
    videoUrl: string,
    description?: string,
    visibility?: 'public' | 'unlisted' | 'private' | 'direct',
  ): Promise<MastodonStatus> {
    // Upload video
    const media = await this.uploadMedia(instanceUrl, accessToken, videoUrl, description);

    // Create status with media
    return this.createStatus(instanceUrl, accessToken, text, {
      mediaIds: [media.id],
      visibility,
    });
  }

  /**
   * Delete a status
   */
  async deleteStatus(
    instanceUrl: string,
    accessToken: string,
    statusId: string,
  ): Promise<void> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(
      `${normalizedUrl}/api/v1/statuses/${statusId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to delete Mastodon status: ${errorData}`);
      throw new BadRequestException('Failed to delete post from Mastodon');
    }
  }

  /**
   * Get user's statuses
   */
  async getAccountStatuses(
    instanceUrl: string,
    accessToken: string,
    accountId: string,
    limit: number = 20,
    maxId?: string,
  ): Promise<{
    statuses: MastodonStatus[];
    nextMaxId?: string;
  }> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);
    const url = new URL(`${normalizedUrl}/api/v1/accounts/${accountId}/statuses`);
    url.searchParams.set('limit', Math.min(limit, 40).toString());
    if (maxId) {
      url.searchParams.set('max_id', maxId);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Mastodon statuses: ${errorData}`);
      throw new BadRequestException('Failed to fetch Mastodon posts');
    }

    const data = await response.json();

    const statuses = data.map((status: any) => ({
      id: status.id,
      uri: status.uri,
      url: status.url,
      content: status.content,
      createdAt: status.created_at,
      reblogsCount: status.reblogs_count || 0,
      favouritesCount: status.favourites_count || 0,
      repliesCount: status.replies_count || 0,
    }));

    return {
      statuses,
      nextMaxId: statuses.length > 0 ? statuses[statuses.length - 1].id : undefined,
    };
  }

  /**
   * Revoke access token
   */
  async revokeToken(
    instanceUrl: string,
    clientId: string,
    clientSecret: string,
    accessToken: string,
  ): Promise<void> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(`${normalizedUrl}/oauth/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        token: accessToken,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to revoke Mastodon token: ${errorData}`);
      // Don't throw - revocation is best effort
    }
  }

  /**
   * Get instance info
   */
  async getInstanceInfo(instanceUrl: string): Promise<{
    name: string;
    description: string;
    version: string;
    maxTootChars: number;
  }> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);

    const response = await fetch(`${normalizedUrl}/api/v1/instance`);

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Mastodon instance info: ${errorData}`);
      throw new BadRequestException('Failed to get Mastodon instance information');
    }

    const data = await response.json();

    return {
      name: data.title || data.uri,
      description: data.short_description || data.description || '',
      version: data.version,
      maxTootChars: data.configuration?.statuses?.max_characters || data.max_toot_chars || 500,
    };
  }

  // ==========================================================================
  // Inbox — fetch status context (descendants = the comment thread)
  // ==========================================================================

  /**
   * Fetch the context of a status — both ancestors and descendants. For our
   * inbox we only consume `descendants`, which is the flat list of replies
   * (Mastodon flattens nested replies into a single list with `in_reply_to_id`
   * pointers so we can rebuild the tree client-side).
   */
  async getStatusContext(
    instanceUrl: string,
    accessToken: string,
    statusId: string,
  ): Promise<{
    ancestors: MastodonStatusContextEntry[];
    descendants: MastodonStatusContextEntry[];
  }> {
    const normalizedUrl = this.normalizeInstanceUrl(instanceUrl);
    const response = await fetch(
      `${normalizedUrl}/api/v1/statuses/${encodeURIComponent(statusId)}/context`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to fetch Mastodon status context: ${errorData}`);
      throw new BadRequestException('Failed to fetch Mastodon status context');
    }

    const data = await response.json();
    return {
      ancestors: (data.ancestors ?? []) as MastodonStatusContextEntry[],
      descendants: (data.descendants ?? []) as MastodonStatusContextEntry[],
    };
  }

  // ==========================================================================
  // Mastodon Direct DM — Phase 2.1
  // ==========================================================================
  // Mastodon "DMs" are statuses with visibility=direct, grouped natively via
  // /api/v1/conversations. Each conversation has an id, unread flag, accounts
  // (participants), and a `last_status`. To fetch the full thread, walk the
  // status `context` (ancestors + descendants).

  /**
   * Strip HTML tags from Mastodon status content to produce plain text.
   */
  private stripHtml(html: string): string {
    if (!html) return '';
    // Replace common block-level tags with newlines/spaces before stripping,
    // so paragraphs/line-breaks don't collapse into a wall of text.
    return html
      .replace(/<br\s*\/?>(?=)/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  /**
   * Extract the Mastodon instance host from the channel metadata.
   * Falls back to `mastodon.social` if not configured.
   */
  private getInstanceFromChannel(channel: ResolvedChannel): string {
    const instance =
      (channel.metadata?.instance as string | undefined) ||
      (channel.metadata?.instanceUrl as string | undefined) ||
      (channel.metadata?.instance_url as string | undefined);

    if (!instance) {
      throw new BadRequestException(
        'Mastodon channel is missing `instance` in metadata — cannot resolve API host',
      );
    }
    return this.normalizeInstanceUrl(instance);
  }

  /**
   * Fetch a single Mastodon conversation by id (paginates if necessary).
   * Returns the raw conversation object or null if not found.
   */
  private async findConversationById(
    instanceUrl: string,
    accessToken: string,
    conversationId: string,
  ): Promise<MastodonConversation | null> {
    let maxId: string | undefined;
    // Cap pagination so we don't run away forever.
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${instanceUrl}/api/v1/conversations`);
      url.searchParams.set('limit', '40');
      if (maxId) url.searchParams.set('max_id', maxId);

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errorData = await response.text();
        this.logger.error(`Failed to list Mastodon conversations: ${errorData}`);
        throw new BadRequestException(
          'Failed to list Mastodon conversations',
        );
      }

      const data = (await response.json()) as MastodonConversation[];
      if (!Array.isArray(data) || data.length === 0) return null;

      const match = data.find((c) => c.id === conversationId);
      if (match) return match;

      maxId = data[data.length - 1]?.id;
      if (!maxId) return null;
    }

    return null;
  }

  /**
   * Map a raw Mastodon status to our FetchedDm shape.
   */
  private mapStatusToFetchedDm(
    status: MastodonStatusContextEntry,
    conversationId: string,
    selfAccountId: string,
  ): FetchedDm {
    const fromMe = status.account?.id === selfAccountId;
    const text = this.stripHtml(status.content ?? '');

    return {
      conversationId,
      platformItemId: status.id,
      platformParentId: status.in_reply_to_id ?? null,
      author: fromMe
        ? null
        : {
            platformId: status.account.id,
            handle: status.account.acct || status.account.username,
            displayName:
              status.account.display_name || status.account.username,
            avatarUrl: status.account.avatar,
          },
      text,
      platformCreatedAt: new Date(status.created_at),
      fromMe,
      metadata: {
        uri: status.uri,
        url: status.url,
        inReplyToAccountId: status.in_reply_to_account_id ?? null,
        accountAcct: status.account.acct,
      },
    };
  }

  /**
   * List Mastodon direct conversations.
   * Endpoint: GET /api/v1/conversations
   */
  async listDirectConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]> {
    const instanceUrl = this.getInstanceFromChannel(channel);
    const url = new URL(`${instanceUrl}/api/v1/conversations`);
    url.searchParams.set('limit', '40');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${channel.accessToken}` },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to list Mastodon conversations: ${errorData}`);
      throw new BadRequestException('Failed to list Mastodon conversations');
    }

    const conversations = (await response.json()) as MastodonConversation[];
    if (!Array.isArray(conversations)) return [];

    const summaries: DmConversationSummary[] = [];

    for (const convo of conversations) {
      const lastStatus = convo.last_status;
      if (!lastStatus) continue;

      // Pick the first non-self participant; if all are self (rare — note to
      // self), fall back to the first account in the list.
      const others = (convo.accounts ?? []).filter(
        (a) => a.id !== channel.platformAccountId,
      );
      const participantAcct =
        others[0] ?? convo.accounts?.[0] ?? null;
      if (!participantAcct) continue;

      const lastMessageAt = new Date(lastStatus.created_at);

      if (since && lastMessageAt <= since) {
        // Older than caller's high-water mark — skip.
        continue;
      }

      summaries.push({
        conversationId: convo.id,
        participant: {
          platformId: participantAcct.id,
          handle: participantAcct.acct || participantAcct.username,
          displayName:
            participantAcct.display_name || participantAcct.username,
          avatarUrl: participantAcct.avatar,
        },
        lastMessageText: this.stripHtml(lastStatus.content ?? ''),
        lastMessageAt,
        lastMessageFromMe:
          lastStatus.account?.id === channel.platformAccountId,
        unreadCount: convo.unread ? 1 : 0,
        metadata: {
          lastStatusId: lastStatus.id,
          lastStatusUri: lastStatus.uri,
          participantAcct: participantAcct.acct || participantAcct.username,
          participantId: participantAcct.id,
          accountIds: (convo.accounts ?? []).map((a) => a.id),
        },
      });
    }

    return summaries;
  }

  /**
   * Fetch all messages in a Mastodon direct conversation. The conversation id
   * resolves to its `last_status.id`; we walk context.ancestors + last_status
   * + descendants to get the full thread.
   */
  async fetchDirectConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    const instanceUrl = this.getInstanceFromChannel(channel);

    const conversation = await this.findConversationById(
      instanceUrl,
      channel.accessToken,
      conversationId,
    );

    if (!conversation || !conversation.last_status) {
      this.logger.warn(
        `Mastodon conversation ${conversationId} not found or has no last_status`,
      );
      return [];
    }

    const lastStatus = conversation.last_status;

    // Fetch the context (ancestors + descendants) around last_status.
    const contextResponse = await fetch(
      `${instanceUrl}/api/v1/statuses/${encodeURIComponent(lastStatus.id)}/context`,
      { headers: { Authorization: `Bearer ${channel.accessToken}` } },
    );

    if (!contextResponse.ok) {
      const errorData = await contextResponse.text();
      this.logger.error(
        `Failed to fetch Mastodon status context: ${errorData}`,
      );
      throw new BadRequestException(
        'Failed to fetch Mastodon conversation messages',
      );
    }

    const contextData = (await contextResponse.json()) as {
      ancestors?: MastodonStatusContextEntry[];
      descendants?: MastodonStatusContextEntry[];
    };

    // last_status is itself a Status (not part of ancestors/descendants); merge
    // it in so the full thread reads chronologically.
    const lastStatusEntry: MastodonStatusContextEntry = {
      id: lastStatus.id,
      uri: lastStatus.uri,
      url: lastStatus.url,
      content: lastStatus.content,
      created_at: lastStatus.created_at,
      in_reply_to_id: lastStatus.in_reply_to_id ?? null,
      in_reply_to_account_id: lastStatus.in_reply_to_account_id ?? null,
      account: lastStatus.account,
      visibility: lastStatus.visibility,
    };

    const all: MastodonStatusContextEntry[] = [
      ...(contextData.ancestors ?? []),
      lastStatusEntry,
      ...(contextData.descendants ?? []),
    ];

    // De-duplicate by id (ancestors/descendants shouldn't overlap with
    // last_status, but defensive).
    const seen = new Set<string>();
    const unique = all.filter((s) => {
      if (!s?.id) return false;
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    // Only consider direct-visibility statuses. Mastodon's context endpoint
    // shouldn't bleed in non-direct replies for a direct-visibility root, but
    // visibility can be missing for older API versions — accept missing as
    // direct.
    const directOnly = unique.filter(
      (s) => !s.visibility || s.visibility === 'direct',
    );

    // Sort chronologically.
    directOnly.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const filtered = since
      ? directOnly.filter((s) => new Date(s.created_at) > since)
      : directOnly;

    return filtered.map((s) =>
      this.mapStatusToFetchedDm(s, conversationId, channel.platformAccountId),
    );
  }

  /**
   * Send a Mastodon direct message — posts a new status with visibility=direct
   * as a reply to the conversation's last_status.
   * Endpoint: POST /api/v1/statuses
   *   body: { status: "@user text", visibility: 'direct', in_reply_to_id }
   */
  async sendDirectMessage(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const instanceUrl = this.getInstanceFromChannel(channel);

    const conversation = await this.findConversationById(
      instanceUrl,
      channel.accessToken,
      conversationId,
    );

    if (!conversation || !conversation.last_status) {
      throw new BadRequestException(
        `Mastodon conversation ${conversationId} not found — cannot send reply`,
      );
    }

    const lastStatus = conversation.last_status;

    // Recipient(s): every account in the conversation that isn't us. Mastodon
    // requires every direct-message recipient to be @-mentioned in the status
    // body, otherwise the visibility=direct still posts but the other party
    // won't receive it in their conversation.
    const recipients = (conversation.accounts ?? []).filter(
      (a) => a.id !== channel.platformAccountId,
    );

    if (recipients.length === 0) {
      throw new BadRequestException(
        `Mastodon conversation ${conversationId} has no other participants to message`,
      );
    }

    const mentions = recipients
      .map((a) => `@${a.acct || a.username}`)
      .join(' ');

    const statusBody = `${mentions} ${text}`.trim();

    const response = await fetch(`${instanceUrl}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channel.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: statusBody,
        visibility: 'direct',
        in_reply_to_id: lastStatus.id,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to send Mastodon DM: ${errorData}`);
      throw new BadRequestException(
        `Failed to send Mastodon direct message: ${errorData}`,
      );
    }

    const data = await response.json();

    return {
      conversationId,
      platformItemId: data.id,
      text: this.stripHtml(data.content ?? statusBody),
      platformCreatedAt: new Date(data.created_at),
    };
  }
}

/**
 * Raw Mastodon conversation shape from /api/v1/conversations.
 */
interface MastodonConversation {
  id: string;
  unread: boolean;
  accounts: Array<{
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  }>;
  last_status: (MastodonStatusContextEntry & {
    visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  }) | null;
}

export interface MastodonStatusContextEntry {
  id: string;
  uri: string;
  url: string;
  content: string; // HTML
  created_at: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  favourites_count?: number;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  };
}
