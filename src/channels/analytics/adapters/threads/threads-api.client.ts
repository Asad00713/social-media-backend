import type {
  ThreadsUser,
  ThreadsPost,
  ThreadsListResponse,
  ThreadsInsightsResponse,
} from './threads.types';

export class ThreadsApiError extends Error {
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
    this.name = 'ThreadsApiError';
  }
}

export class ThreadsApiClient {
  private readonly baseUrl = 'https://graph.threads.net/v1.0';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getMe(accessToken: string): Promise<ThreadsUser> {
    const params = new URLSearchParams({
      fields: 'id,username,name,threads_profile_picture_url,threads_biography',
    });
    return this.request<ThreadsUser>(
      `${this.baseUrl}/me?${params}`,
      accessToken,
    );
  }

  async getMyThreads(opts: {
    accessToken: string;
    limit?: number;
    since?: number;
  }): Promise<ThreadsListResponse> {
    const params = new URLSearchParams({
      fields:
        'id,media_type,media_url,permalink,text,timestamp,thumbnail_url,is_quote_post',
      limit: String(opts.limit ?? 25),
    });
    if (opts.since) params.set('since', String(opts.since));
    return this.request<ThreadsListResponse>(
      `${this.baseUrl}/me/threads?${params}`,
      opts.accessToken,
    );
  }

  async getThread(threadId: string, accessToken: string): Promise<ThreadsPost> {
    const params = new URLSearchParams({
      fields:
        'id,media_type,media_url,permalink,text,timestamp,thumbnail_url,is_quote_post',
    });
    return this.request<ThreadsPost>(
      `${this.baseUrl}/${threadId}?${params}`,
      accessToken,
    );
  }

  async getThreadInsights(
    threadId: string,
    accessToken: string,
  ): Promise<ThreadsInsightsResponse> {
    const params = new URLSearchParams({
      metric: 'views,likes,replies,reposts,quotes',
    });
    return this.request<ThreadsInsightsResponse>(
      `${this.baseUrl}/${threadId}/insights?${params}`,
      accessToken,
    );
  }

  async getUserInsights(accessToken: string): Promise<ThreadsInsightsResponse> {
    // Meta requires `since` for some metrics — pass last 30 days as a safe default
    const since = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const params = new URLSearchParams({
      metric: 'followers_count,views,likes,replies,reposts,quotes',
      since: String(since),
    });
    return this.request<ThreadsInsightsResponse>(
      `${this.baseUrl}/me/threads_insights?${params}`,
      accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = body.error ?? {};
      throw new ThreadsApiError(
        this.mapCode(res.status, err),
        res.status,
        err.message ?? `HTTP ${res.status}`,
      );
    }
    return res.json() as Promise<T>;
  }

  private mapCode(
    status: number,
    err: { code?: number },
  ): ThreadsApiError['code'] {
    if (
      err.code === 4 ||
      err.code === 17 ||
      err.code === 32 ||
      err.code === 613
    )
      return 'rate_limited';
    if (err.code === 190 || err.code === 102) return 'auth_failed';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
