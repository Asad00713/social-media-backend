import type {
  YouTubeChannelsListResponse,
  YouTubeSearchListResponse,
  YouTubeVideosListResponse,
} from './youtube.types';

export class YouTubeApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper around YouTube Data API v3. Constructor takes a fetch impl so
 * tests can inject a mock. Production uses global fetch.
 */
export class YouTubeDataApiClient {
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getChannelById(channelId: string, accessToken: string): Promise<YouTubeChannelsListResponse> {
    const url = `${this.baseUrl}/channels?part=${encodeURIComponent('snippet,statistics,contentDetails')}&id=${encodeURIComponent(channelId)}`;
    return this.request<YouTubeChannelsListResponse>(url, accessToken);
  }

  async listChannelVideos(
    channelId: string,
    accessToken: string,
    opts: { maxResults?: number; pageToken?: string; publishedAfter?: string } = {},
  ): Promise<YouTubeSearchListResponse> {
    const params = new URLSearchParams({
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: String(opts.maxResults ?? 50),
    });
    if (opts.pageToken) params.set('pageToken', opts.pageToken);
    if (opts.publishedAfter) params.set('publishedAfter', opts.publishedAfter);
    return this.request<YouTubeSearchListResponse>(`${this.baseUrl}/search?${params}`, accessToken);
  }

  async getVideosByIds(videoIds: string[], accessToken: string): Promise<YouTubeVideosListResponse> {
    const params = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
    });
    return this.request<YouTubeVideosListResponse>(`${this.baseUrl}/videos?${params}`, accessToken);
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      throw new YouTubeApiError(this.mapErrorCode(res.status, message), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  private mapErrorCode(status: number, message: string): YouTubeApiError['code'] {
    if (status === 401) return 'auth_failed';
    if (status === 403 && /quota/i.test(message)) return 'rate_limited';
    if (status === 403) return 'auth_failed';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
