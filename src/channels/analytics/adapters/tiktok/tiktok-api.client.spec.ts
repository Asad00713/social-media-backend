import { TikTokApiClient, TikTokApiError } from './tiktok-api.client';

describe('TikTokApiClient', () => {
  let client: TikTokApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new TikTokApiClient(mockFetch as any);
  });

  it('getUserInfo hits GET /user/info with fields query param and Authorization header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          user: {
            open_id: 'abc123',
            display_name: 'Test User',
            follower_count: 5000,
          },
        },
        error: { code: 'ok', message: '' },
      }),
    });
    const user = await client.getUserInfo('fake-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/user/info/?fields=');
    expect(url).toContain('follower_count');
    expect(opts.headers.Authorization).toBe('Bearer fake-token');
    expect(opts.method).toBeUndefined(); // GET by default
    expect(user.open_id).toBe('abc123');
    expect(user.follower_count).toBe(5000);
  });

  it('getVideoList sends POST with correct body including max_count and cursor', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          videos: [
            { id: 'v1', create_time: 1700000000, view_count: 1000 },
          ],
          cursor: 20,
          has_more: false,
        },
        error: { code: 'ok', message: '' },
      }),
    });
    const result = await client.getVideoList({ accessToken: 'tok', maxCount: 10, cursor: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/video/list/?fields=');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body as string);
    expect(body.max_count).toBe(10);
    expect(body.cursor).toBe(5);
    expect(result.videos).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it('queryVideos sends POST with video_ids filter', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          videos: [
            {
              id: 'v1',
              create_time: 1700000000,
              view_count: 500,
              like_count: 100,
              comment_count: 10,
              share_count: 5,
            },
          ],
          cursor: 0,
          has_more: false,
        },
        error: { code: 'ok', message: '' },
      }),
    });
    const videos = await client.queryVideos({ accessToken: 'tok', videoIds: ['v1', 'v2'] });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/video/query/?fields=');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.filters.video_ids).toEqual(['v1', 'v2']);
    expect(videos).toHaveLength(1);
    expect(videos[0].view_count).toBe(500);
  });

  it('throws TikTokApiError with rate_limited on rate_limit_exceeded error code', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }),
    });
    await expect(client.getUserInfo('tok')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('throws TikTokApiError with auth_failed on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'access_token_invalid', message: 'Invalid token' } }),
    });
    await expect(client.getUserInfo('bad-tok')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 401,
    });
  });

  it('throws TikTokApiError with transient on 500 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(client.getUserInfo('tok')).rejects.toMatchObject({
      code: 'transient',
      status: 500,
    });
  });
});
