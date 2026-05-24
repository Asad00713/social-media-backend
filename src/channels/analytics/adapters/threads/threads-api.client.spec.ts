import { ThreadsApiClient, ThreadsApiError } from './threads-api.client';

describe('ThreadsApiClient', () => {
  const mockFetch = jest.fn();
  let client: ThreadsApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ThreadsApiClient(mockFetch as any);
  });

  it('getMe requests correct fields and returns user shape', async () => {
    const userData = {
      id: 'u-123',
      username: 'testuser',
      name: 'Test User',
      threads_profile_picture_url: 'https://example.com/pic.jpg',
      threads_biography: 'Bio text',
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => userData });

    const result = await client.getMe('access-token-abc');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('graph.threads.net/v1.0/me');
    expect(url).toContain('id');
    expect(url).toContain('username');
    expect(url).toContain('threads_profile_picture_url');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer access-token-abc',
    });
    expect(result.id).toBe('u-123');
    expect(result.username).toBe('testuser');
    expect(result.threads_biography).toBe('Bio text');
  });

  it('getMyThreads passes limit and since params', async () => {
    const listData = { data: [], paging: {} };
    mockFetch.mockResolvedValue({ ok: true, json: async () => listData });

    await client.getMyThreads({ accessToken: 'tok', limit: 10, since: 1700000000 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('me/threads');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1700000000');
    expect(url).toContain('text');
    expect(url).toContain('timestamp');
  });

  it('maps error code 190 to auth_failed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 190,
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
        },
      }),
    });

    await expect(client.getMe('bad-token')).rejects.toMatchObject({
      code: 'auth_failed',
      status: 400,
    });
  });

  it('maps error code 4 to rate_limited', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 4, message: 'App request limit reached.' } }),
    });

    await expect(client.getMe('tok')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('maps HTTP 404 to not_found', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: {} }),
    });

    await expect(client.getThread('bad-id', 'tok')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('maps HTTP 500 to transient', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: {} }),
    });

    await expect(client.getMe('tok')).rejects.toMatchObject({ code: 'transient' });
  });

  it('getThreadInsights requests correct metrics', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getThreadInsights('thread-123', 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('thread-123/insights');
    expect(url).toContain('views');
    expect(url).toContain('likes');
    expect(url).toContain('replies');
    expect(url).toContain('reposts');
    expect(url).toContain('quotes');
  });

  it('getUserInsights includes followers_count metric and since param', async () => {
    const insightsData = { data: [] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => insightsData });

    await client.getUserInsights('tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('me/threads_insights');
    expect(url).toContain('followers_count');
    expect(url).toContain('since=');
  });
});
