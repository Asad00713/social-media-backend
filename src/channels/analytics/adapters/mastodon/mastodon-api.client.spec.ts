import { MastodonApiClient, MastodonApiError } from './mastodon-api.client';

describe('MastodonApiClient', () => {
  let client: MastodonApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new MastodonApiClient(mockFetch as any);
  });

  it('verifyCredentials hits /api/v1/accounts/verify_credentials with bearer auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '109302715060751367',
        username: 'testuser',
        acct: 'testuser',
        display_name: 'Test User',
        note: '<p>A bio</p>',
        url: 'https://mastodon.social/@testuser',
        avatar: 'https://mastodon.social/avatar.jpg',
        header: 'https://mastodon.social/header.jpg',
        followers_count: 123,
        following_count: 45,
        statuses_count: 200,
        created_at: '2022-12-01T00:00:00.000Z',
      }),
    });

    const account = await client.verifyCredentials('mastodon.social', 'fake-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/accounts/verify_credentials');
    expect(url).toContain('https://mastodon.social');
    expect(opts.headers.Authorization).toBe('Bearer fake-token');
    expect(account.followers_count).toBe(123);
    expect(account.statuses_count).toBe(200);
  });

  it('getAccountStatuses includes limit param and normalises instance URL with trailing slash', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ([]),
    });

    await client.getAccountStatuses({
      instanceUrl: 'https://mastodon.social/',
      accountId: '109302715060751367',
      accessToken: 'fake-token',
      limit: 20,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/accounts/109302715060751367/statuses');
    expect(url).toContain('limit=20');
    // Trailing slash stripped
    expect(url).not.toContain('mastodon.social//');
  });

  it('getAccountStatuses includes since_id when provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ([]) });

    await client.getAccountStatuses({
      instanceUrl: 'mastodon.social',
      accountId: '12345',
      accessToken: 'token',
      sinceId: '109302715060751367',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('since_id=109302715060751367');
  });

  it('throws MastodonApiError with auth_failed on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'The access token is invalid' }),
    });

    await expect(client.verifyCredentials('mastodon.social', 'bad-token'))
      .rejects.toMatchObject({ code: 'auth_failed', status: 401 });
  });

  it('throws MastodonApiError with rate_limited on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Too many requests' }),
    });

    await expect(client.verifyCredentials('mastodon.social', 'token'))
      .rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('throws MastodonApiError with transient on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    });

    await expect(client.verifyCredentials('mastodon.social', 'token'))
      .rejects.toMatchObject({ code: 'transient', status: 500 });
  });

  it('getStatus hits /api/v1/statuses/{id}', async () => {
    const mockStatus = {
      id: '109302715060751367',
      uri: 'https://mastodon.social/users/testuser/statuses/109302715060751367',
      url: 'https://mastodon.social/@testuser/109302715060751367',
      created_at: '2022-12-01T00:00:00.000Z',
      content: '<p>Hello world</p>',
      favourites_count: 10,
      reblogs_count: 3,
      replies_count: 1,
      media_attachments: [],
    };

    mockFetch.mockResolvedValue({ ok: true, json: async () => mockStatus });

    const status = await client.getStatus({
      instanceUrl: 'https://mastodon.social',
      statusId: '109302715060751367',
      accessToken: 'token',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/statuses/109302715060751367');
    expect(status.favourites_count).toBe(10);
    expect(status.reblogs_count).toBe(3);
  });
});
