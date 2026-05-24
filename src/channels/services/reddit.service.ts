import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RedditMe {
  id: string;
  name: string;
  icon_img?: string;
  link_karma: number;
  comment_karma: number;
}

export interface RedditSubreddit {
  id: string;
  display_name: string;
  title: string;
  subscribers: number;
  over18: boolean;
  icon_img?: string;
  url: string;
}

export interface RedditFlair {
  id: string;
  text: string;
  type: string;
  background_color?: string;
  text_color?: string;
  text_editable?: boolean;
  mod_only?: boolean;
}

export interface SubmitOptions {
  subreddit: string; // without 'r/' prefix
  kind: 'self' | 'link' | 'image';
  title: string;
  text?: string;
  url?: string;
  flairId?: string;
  flairText?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  sendReplies?: boolean;
}

export interface RedditTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

/**
 * Reddit API client. All calls hit oauth.reddit.com (NOT www.reddit.com)
 * and every request must include a unique User-Agent — Reddit blocks
 * generic UAs as suspected spam.
 */
@Injectable()
export class RedditService {
  private readonly apiBaseUrl = 'https://oauth.reddit.com';
  private readonly userAgent: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly logger = new Logger(RedditService.name);

  constructor(private readonly config: ConfigService) {
    this.userAgent = this.config.get<string>('REDDIT_USER_AGENT') ?? 'Schedura/1.0';
    this.clientId = this.config.get<string>('REDDIT_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('REDDIT_CLIENT_SECRET') ?? '';
  }

  /** GET /api/v1/me — used right after OAuth to fetch username + id. */
  async getMe(accessToken: string): Promise<RedditMe> {
    const data = await this.authedFetch(accessToken, '/api/v1/me');
    return {
      id: data.id,
      name: data.name,
      icon_img: data.icon_img,
      link_karma: data.link_karma,
      comment_karma: data.comment_karma,
    };
  }

  /** GET /subreddits/mine/subscriber — subs the user is subscribed to or mods. */
  async listSubredditsMine(
    accessToken: string,
    limit = 100,
  ): Promise<RedditSubreddit[]> {
    const data = await this.authedFetch(
      accessToken,
      `/subreddits/mine/subscriber?limit=${limit}`,
    );
    const children = (data?.data?.children ?? []) as Array<{
      data: Record<string, any>;
    }>;
    return children.map((c) => ({
      id: c.data.id,
      display_name: c.data.display_name,
      title: c.data.title,
      subscribers: c.data.subscribers ?? 0,
      over18: Boolean(c.data.over18),
      icon_img: c.data.community_icon || c.data.icon_img,
      url: c.data.url,
    }));
  }

  /** GET /r/{subreddit}/api/link_flair_v2 — post flairs configured by mods. */
  async getSubredditFlairs(
    accessToken: string,
    subreddit: string,
  ): Promise<RedditFlair[]> {
    try {
      const data = await this.authedFetch(
        accessToken,
        `/r/${encodeURIComponent(subreddit)}/api/link_flair_v2`,
      );
      if (!Array.isArray(data)) return [];
      return data.map((f: any) => ({
        id: f.id,
        text: f.text,
        type: f.type,
        background_color: f.background_color,
        text_color: f.text_color,
        text_editable: f.text_editable,
        mod_only: f.mod_only,
      }));
    } catch (err) {
      // Many subs hide flairs or return 403; treat as empty rather than failing.
      this.logger.warn(
        `Could not fetch flairs for r/${subreddit}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /** POST /api/submit — create a post. */
  async submit(
    accessToken: string,
    opts: SubmitOptions,
  ): Promise<{ id: string; name: string; url: string }> {
    if (!opts.title || opts.title.length > 300) {
      throw new BadRequestException('Reddit post title is required and ≤300 chars');
    }
    if (!opts.subreddit) {
      throw new BadRequestException('Reddit post requires a subreddit');
    }

    const params = new URLSearchParams();
    params.set('api_type', 'json');
    params.set('sr', opts.subreddit);
    params.set('kind', opts.kind);
    params.set('title', opts.title);
    if (opts.text) params.set('text', opts.text);
    if (opts.url) params.set('url', opts.url);
    if (opts.flairId) params.set('flair_id', opts.flairId);
    if (opts.flairText) params.set('flair_text', opts.flairText);
    if (opts.nsfw) params.set('nsfw', 'true');
    if (opts.spoiler) params.set('spoiler', 'true');
    params.set('sendreplies', String(opts.sendReplies ?? true));

    const response = await fetch(`${this.apiBaseUrl}/api/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Reddit submit failed: ${response.status} ${errorText}`);
      throw new BadRequestException(
        `Reddit API error (${response.status}): ${errorText.slice(0, 200)}`,
      );
    }

    const body = await response.json();
    const errors = body?.json?.errors as Array<[string, string, string]> | undefined;
    if (errors && errors.length > 0) {
      const [code, message] = errors[0];
      throw new BadRequestException(`${code}: ${message}`);
    }

    const data = body?.json?.data;
    if (!data?.id || !data?.url) {
      throw new BadRequestException('Reddit submit returned no post id');
    }
    return {
      id: data.id,
      name: data.name ?? `t3_${data.id}`,
      url: data.url,
    };
  }

  /** POST https://www.reddit.com/api/v1/access_token — refresh flow. */
  async refreshToken(refreshToken: string): Promise<RedditTokenResponse> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be set');
    }
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    );
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Reddit token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresIn: data.expires_in ?? 3600,
      tokenType: data.token_type ?? 'Bearer',
      scope: data.scope ?? '',
    };
  }

  /** Internal helper — every Reddit request needs Bearer + User-Agent. */
  private async authedFetch(
    accessToken: string,
    path: string,
    init?: RequestInit,
  ): Promise<any> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Reddit API ${path} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }
}
