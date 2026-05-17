import type {
  InstagramUser,
  InstagramMedia,
  InstagramMediaListResponse,
  InstagramMediaInsights,
} from './instagram.types';

export class InstagramApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

export class InstagramApiClient {
  private readonly baseUrl = 'https://graph.facebook.com/v22.0';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUser(igUserId: string, accessToken: string): Promise<InstagramUser> {
    const params = new URLSearchParams({
      fields:
        'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    });
    return this.request<InstagramUser>(`${this.baseUrl}/${igUserId}?${params}`, accessToken);
  }

  async getUserMedia(opts: {
    igUserId: string;
    accessToken: string;
    limit?: number;
  }): Promise<InstagramMediaListResponse> {
    const params = new URLSearchParams({
      fields:
        'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit: String(opts.limit ?? 25),
    });
    return this.request<InstagramMediaListResponse>(
      `${this.baseUrl}/${opts.igUserId}/media?${params}`,
      opts.accessToken,
    );
  }

  async getMedia(mediaId: string, accessToken: string): Promise<InstagramMedia> {
    const params = new URLSearchParams({
      fields:
        'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    });
    return this.request<InstagramMedia>(`${this.baseUrl}/${mediaId}?${params}`, accessToken);
  }

  async getMediaInsights(
    mediaId: string,
    mediaType: string,
    accessToken: string,
  ): Promise<InstagramMediaInsights> {
    // Insight metrics differ by media type. We pick a superset; API ignores unsupported
    // metrics by returning an error — caught and degraded to partial status upstream.
    const metricsByType: Record<string, string> = {
      REEL: 'plays,reach,likes,comments,shares,saved',
      VIDEO: 'plays,reach,impressions,saved',
      STORY: 'impressions,reach,exits,replies',
      IMAGE: 'impressions,reach,engagement,saved',
      CAROUSEL_ALBUM: 'impressions,reach,engagement,saved',
    };
    const metric = metricsByType[mediaType] ?? 'impressions,reach,engagement,saved';
    const params = new URLSearchParams({ metric });
    return this.request<InstagramMediaInsights>(
      `${this.baseUrl}/${mediaId}/insights?${params}`,
      accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const igError = (body as any).error ?? {};
      const message = igError.message ?? `HTTP ${res.status}`;
      throw new InstagramApiError(this.mapCode(res.status, igError), res.status, message);
    }
    return res.json() as Promise<T>;
  }

  private mapCode(
    status: number,
    igError: { code?: number; type?: string },
  ): InstagramApiError['code'] {
    // Meta-specific error codes (shared with Facebook adapter)
    if (
      igError.code === 4 ||
      igError.code === 17 ||
      igError.code === 32 ||
      igError.code === 613
    )
      return 'rate_limited';
    if (igError.code === 190 || igError.code === 102) return 'auth_failed';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
