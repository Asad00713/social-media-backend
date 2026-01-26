import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
}
