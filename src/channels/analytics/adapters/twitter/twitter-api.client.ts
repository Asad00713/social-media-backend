import type {
  TwitterUser,
  TwitterUserResponse,
  TwitterTweet,
  TwitterUserTweetsResponse,
  TwitterTweetResponse,
} from './twitter.types';

export class TwitterApiError extends Error {
  constructor(
    public code:
      | 'rate_limited'
      | 'auth_failed'
      | 'not_found'
      | 'transient'
      | 'permanent'
      | 'tier_required',
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TwitterApiError';
  }
}

/**
 * Thin wrapper around Twitter API v2. Constructor takes a fetch impl so
 * tests can inject a mock. Production uses global fetch.
 *
 * Auth: OAuth 2.0 Bearer token (app-only or user context).
 *
 * IMPORTANT tier notes:
 *  - Free tier: public_metrics available; impression_count NOT included
 *  - Basic tier ($100/mo): non_public_metrics and organic_metrics available
 *  - getTweet() will gracefully downgrade from non_public → public on 403
 */
export class TwitterApiClient {
  private readonly baseUrl = 'https://api.twitter.com/2';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getMe(accessToken: string): Promise<TwitterUser> {
    const params = new URLSearchParams({
      'user.fields':
        'id,name,username,description,profile_image_url,public_metrics,verified',
    });
    const body = await this.request<TwitterUserResponse>(
      `${this.baseUrl}/users/me?${params}`,
      accessToken,
    );
    return body.data;
  }

  async getUserTweets(opts: {
    userId: string;
    accessToken: string;
    maxResults?: number;
    startTime?: string;
  }): Promise<{
    tweets: TwitterTweet[];
    media: Map<
      string,
      { url?: string; previewImageUrl?: string; type: string }
    >;
  }> {
    const params = new URLSearchParams({
      max_results: String(opts.maxResults ?? 25),
      'tweet.fields': 'public_metrics,created_at,attachments,author_id',
      expansions: 'attachments.media_keys',
      'media.fields': 'media_key,type,url,preview_image_url',
    });
    if (opts.startTime) params.set('start_time', opts.startTime);

    const body = await this.request<TwitterUserTweetsResponse>(
      `${this.baseUrl}/users/${encodeURIComponent(opts.userId)}/tweets?${params}`,
      opts.accessToken,
    );

    const media = new Map<
      string,
      { url?: string; previewImageUrl?: string; type: string }
    >();
    for (const m of body.includes?.media ?? []) {
      media.set(m.media_key, {
        url: m.url,
        previewImageUrl: m.preview_image_url,
        type: m.type,
      });
    }

    return { tweets: body.data ?? [], media };
  }

  async getTweet(opts: {
    tweetId: string;
    accessToken: string;
    includeNonPublic?: boolean;
  }): Promise<TwitterTweet | null> {
    const fields = opts.includeNonPublic
      ? 'public_metrics,non_public_metrics,organic_metrics,created_at'
      : 'public_metrics,created_at';
    const params = new URLSearchParams({ 'tweet.fields': fields });

    try {
      const body = await this.request<TwitterTweetResponse>(
        `${this.baseUrl}/tweets/${encodeURIComponent(opts.tweetId)}?${params}`,
        opts.accessToken,
      );
      return body.data ?? null;
    } catch (err) {
      // If we asked for non_public metrics and got 403 (tier gate), downgrade to public only
      if (opts.includeNonPublic && (err as TwitterApiError)?.status === 403) {
        return this.getTweet({ ...opts, includeNonPublic: false });
      }
      throw err;
    }
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.detail ?? body.title ?? `HTTP ${res.status}`;
      throw new TwitterApiError(
        this.mapCode(res.status, message),
        res.status,
        message,
      );
    }

    return res.json() as Promise<T>;
  }

  private mapCode(status: number, message: string): TwitterApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 403) {
      if (/access level|tier|Pro|Basic|Enterprise/i.test(message))
        return 'tier_required';
      return 'auth_failed';
    }
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
