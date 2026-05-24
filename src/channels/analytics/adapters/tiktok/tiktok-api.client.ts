import type {
  TikTokUserInfo,
  TikTokUserInfoResponse,
  TikTokVideo,
  TikTokVideoListResponse,
} from './tiktok.types';

export class TikTokApiError extends Error {
  constructor(
    public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper around TikTok Display API v2. Constructor takes a fetch impl so
 * tests can inject a mock. Production uses global fetch.
 *
 * TikTok requires POST-based queries for video endpoints with fields specified
 * as query parameters. User info uses GET with fields in query string.
 */
export class TikTokApiClient {
  private readonly baseUrl = 'https://open.tiktokapis.com/v2';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUserInfo(accessToken: string): Promise<TikTokUserInfo> {
    const fields =
      'open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count';
    const res = await this.fetchImpl(`${this.baseUrl}/user/info/?fields=${fields}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json().catch(() => ({}))) as TikTokUserInfoResponse;
    if (!res.ok || (body.error?.code && body.error.code !== 'ok')) {
      const msg = body.error?.message ?? `HTTP ${res.status}`;
      throw new TikTokApiError(this.mapCode(res.status, body.error?.code), res.status, msg);
    }
    return body.data.user;
  }

  async getVideoList(opts: {
    accessToken: string;
    maxCount?: number;
    cursor?: number;
  }): Promise<{ videos: TikTokVideo[]; cursor: number; hasMore: boolean }> {
    const fields =
      'id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count';
    const url = `${this.baseUrl}/video/list/?fields=${fields}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ max_count: opts.maxCount ?? 20, cursor: opts.cursor ?? 0 }),
    });
    const body = (await res.json().catch(() => ({}))) as TikTokVideoListResponse;
    if (!res.ok || (body.error?.code && body.error.code !== 'ok')) {
      throw new TikTokApiError(
        this.mapCode(res.status, body.error?.code),
        res.status,
        body.error?.message ?? `HTTP ${res.status}`,
      );
    }
    return {
      videos: body.data.videos ?? [],
      cursor: body.data.cursor,
      hasMore: body.data.has_more,
    };
  }

  async queryVideos(opts: { accessToken: string; videoIds: string[] }): Promise<TikTokVideo[]> {
    const fields =
      'id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count';
    const url = `${this.baseUrl}/video/query/?fields=${fields}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filters: { video_ids: opts.videoIds } }),
    });
    const body = (await res.json().catch(() => ({}))) as TikTokVideoListResponse;
    if (!res.ok || (body.error?.code && body.error.code !== 'ok')) {
      throw new TikTokApiError(
        this.mapCode(res.status, body.error?.code),
        res.status,
        body.error?.message ?? `HTTP ${res.status}`,
      );
    }
    return body.data.videos ?? [];
  }

  private mapCode(status: number, errorCode?: string): TikTokApiError['code'] {
    if (errorCode === 'rate_limit_exceeded') return 'rate_limited';
    if (errorCode === 'access_token_invalid' || errorCode === 'unauthorized') return 'auth_failed';
    if (errorCode === 'not_found') return 'not_found';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status >= 500) return 'transient';
    return 'permanent';
  }
}
