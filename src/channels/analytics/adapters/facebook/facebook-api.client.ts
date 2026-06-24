import type {
  FacebookPage,
  FacebookPagePost,
  FacebookPagePostsResponse,
  FacebookPostInsights,
} from './facebook.types';

export class FacebookApiError extends Error {
  constructor(
    public code:
      | 'rate_limited'
      | 'auth_failed'
      | 'not_found'
      | 'transient'
      | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FacebookApiError';
  }
}

export class FacebookApiClient {
  private readonly baseUrl = 'https://graph.facebook.com/v22.0';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getPage(pageId: string, accessToken: string): Promise<FacebookPage> {
    const params = new URLSearchParams({
      fields:
        'id,name,fan_count,followers_count,about,picture.type(large),verification_status,category',
    });
    return this.request<FacebookPage>(
      `${this.baseUrl}/${pageId}?${params}`,
      accessToken,
    );
  }

  async getPagePosts(opts: {
    pageId: string;
    accessToken: string;
    limit?: number;
    since?: number; // unix seconds
  }): Promise<FacebookPagePostsResponse> {
    const params = new URLSearchParams({
      fields:
        'id,message,created_time,full_picture,permalink_url,reactions.summary(true),comments.summary(true),shares,likes.summary(true)',
      limit: String(opts.limit ?? 25),
    });
    if (opts.since) params.set('since', String(opts.since));
    return this.request<FacebookPagePostsResponse>(
      `${this.baseUrl}/${opts.pageId}/posts?${params}`,
      opts.accessToken,
    );
  }

  async getPost(
    postId: string,
    accessToken: string,
  ): Promise<FacebookPagePost> {
    const params = new URLSearchParams({
      fields:
        'id,message,created_time,full_picture,permalink_url,reactions.summary(true),comments.summary(true),shares,likes.summary(true)',
    });
    return this.request<FacebookPagePost>(
      `${this.baseUrl}/${postId}?${params}`,
      accessToken,
    );
  }

  async getPostInsights(
    postId: string,
    accessToken: string,
  ): Promise<FacebookPostInsights> {
    const params = new URLSearchParams({
      metric: 'post_impressions,post_impressions_unique,post_engaged_users',
    });
    return this.request<FacebookPostInsights>(
      `${this.baseUrl}/${postId}/insights?${params}`,
      accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const fbError = body.error ?? {};
      const message = fbError.message ?? `HTTP ${res.status}`;
      throw new FacebookApiError(
        this.mapCode(res.status, fbError),
        res.status,
        message,
      );
    }
    return res.json() as Promise<T>;
  }

  private mapCode(
    status: number,
    fbError: { code?: number; type?: string },
  ): FacebookApiError['code'] {
    // Meta-specific error codes
    if (
      fbError.code === 4 ||
      fbError.code === 17 ||
      fbError.code === 32 ||
      fbError.code === 613
    )
      return 'rate_limited';
    if (fbError.code === 190 || fbError.code === 102) return 'auth_failed';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
