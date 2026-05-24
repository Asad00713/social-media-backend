import { BlueskyApiClient, BlueskyApiError } from './bluesky-api.client';

describe('BlueskyApiClient', () => {
  let client: BlueskyApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new BlueskyApiClient(mockFetch as any);
  });

  it('getProfile hits app.bsky.actor.getProfile with the actor param + bearer auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        did: 'did:plc:x',
        followersCount: 5,
        followsCount: 3,
        postsCount: 12,
        handle: 'asad.bsky.social',
      }),
    });
    await client.getProfile('asad.bsky.social', 'fake-jwt');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/app.bsky.actor.getProfile');
    expect(url).toContain('actor=asad.bsky.social');
    expect(opts.headers.Authorization).toBe('Bearer fake-jwt');
  });

  it('getAuthorFeed includes limit + cursor', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ feed: [] }) });
    await client.getAuthorFeed({ actor: 'asad.bsky.social', accessJwt: 'jwt', limit: 25, cursor: 'abc' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('limit=25');
    expect(url).toContain('cursor=abc');
  });

  it('throws BlueskyApiError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'invalid jwt' }),
    });
    await expect(client.getProfile('asad.bsky.social', 'bad-jwt'))
      .rejects.toMatchObject({ code: 'auth_failed', status: 401 });
  });

  it('throws BlueskyApiError with rate_limited on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'rate limited' }),
    });
    await expect(client.getProfile('asad.bsky.social', 'jwt'))
      .rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('getPostThread includes uri param + depth=0', async () => {
    const atUri = 'at://did:plc:abc/app.bsky.feed.post/rkey123';
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ thread: { post: { uri: atUri, cid: 'cid1', likeCount: 5, repostCount: 2, replyCount: 1, indexedAt: '2024-01-01T00:00:00Z', author: { did: 'did:plc:abc', handle: 'test.bsky.social' }, record: { text: 'hello', createdAt: '2024-01-01T00:00:00Z' } } } }),
    });
    await client.getPostThread(atUri, 'jwt');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/app.bsky.feed.getPostThread');
    expect(url).toContain('depth=0');
    expect(url).toContain(encodeURIComponent(atUri));
  });
});
