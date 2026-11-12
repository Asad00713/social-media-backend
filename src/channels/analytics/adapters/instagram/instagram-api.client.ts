import type {
  InstagramUser,
  InstagramMedia,
  InstagramMediaListResponse,
  InstagramMediaInsights,
} from './instagram.types';

export class InstagramApiError extends Error {
  constructor(
    public code:
      | 'rate_limited'
      | 'auth_failed'
      | 'not_found'
      | 'transient'
      | 'permanent',
    public status: number,
    message: string,
    /** Numeric `error.code` from the Graph error body, when present. */
    public metaCode?: number,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

const CORE_INSIGHT_METRICS = 'views,reach';

/**
 * Metric list Meta accepts for a media product type. One unsupported name
 * fails the whole request, so each type asks only for what it serves.
 * `coreOnly` returns just views and reach, the fallback when the full set is
 * rejected.
 *   https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
 * `follows` and `profile_visits` exist for FEED but not REELS.
 */
export function instagramInsightMetrics(
  mediaProductType: string | undefined,
  coreOnly = false,
): string {
  if (coreOnly) return CORE_INSIGHT_METRICS;
  const metricsByProductType: Record<string, string> = {
    REELS: 'views,reach,saved,shares',
    STORY: CORE_INSIGHT_METRICS,
  };
  return (
    (mediaProductType && metricsByProductType[mediaProductType]) ??
    'views,reach,saved,shares,follows,profile_visits'
  );
}

export class InstagramApiClient {
  // Instagram Business Login tokens are issued for graph.instagram.com,
  // NOT graph.facebook.com. Hitting Facebook's graph with an IG token
  // returns "Cannot parse access token" (code 190). The IG graph host is
  // unversioned. Reference:
  //   https://developers.facebook.com/docs/instagram-platform/reference/instagram-user/media
  //
  // Shipped but untested with a live account — verify in smoke test.
  private readonly baseUrl = 'https://graph.instagram.com';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUser(igUserId: string, accessToken: string): Promise<InstagramUser> {
    const params = new URLSearchParams({
      fields:
        'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    });
    return this.request<InstagramUser>(
      `${this.baseUrl}/${igUserId}?${params}`,
      accessToken,
    );
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

  async getMedia(
    mediaId: string,
    accessToken: string,
  ): Promise<InstagramMedia> {
    // media_product_type (FEED | REELS | STORY | AD) decides which insight
    // metrics Meta accepts for this media; media_type alone cannot tell a
    // reel from a video.
    const params = new URLSearchParams({
      fields:
        'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    });
    return this.request<InstagramMedia>(
      `${this.baseUrl}/${mediaId}?${params}`,
      accessToken,
    );
  }

  async getMediaInsights(
    mediaId: string,
    mediaProductType: string | undefined,
    accessToken: string,
    coreOnly = false,
  ): Promise<InstagramMediaInsights> {
    // Meta retired impressions, plays and engagement for media created after
    // 2 July 2024; `views` replaces them.
    const metric = instagramInsightMetrics(mediaProductType, coreOnly);
    const params = new URLSearchParams({ metric });
    return this.request<InstagramMediaInsights>(
      `${this.baseUrl}/${mediaId}/insights?${params}`,
      accessToken,
    );
  }

  /**
   * Follower demographics for one breakdown. Meta returns nothing for an
   * account under 100 followers. `timeframe` is required for demographic
   * metrics; the 30-day window is the freshest that is not month-boundary
   * sensitive.
   *   https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
   * The value formats for city, age and gender are not in Meta's docs.
   */
  async getFollowerDemographics(
    igUserId: string,
    accessToken: string,
    breakdown: 'country' | 'city' | 'age' | 'gender',
  ): Promise<unknown> {
    const params = new URLSearchParams({
      metric: 'follower_demographics',
      metric_type: 'total_value',
      period: 'lifetime',
      timeframe: 'last_30_days',
      breakdown,
    });
    return this.request<unknown>(
      `${this.baseUrl}/${igUserId}/insights?${params}`,
      accessToken,
    );
  }

  private async request<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const igError = body.error ?? {};
      const message = igError.message ?? `HTTP ${res.status}`;
      throw new InstagramApiError(
        this.mapCode(res.status, igError),
        res.status,
        message,
        typeof igError.code === 'number' ? igError.code : undefined,
      );
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
