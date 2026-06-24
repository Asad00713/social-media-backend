import { TwitterApiClient, TwitterApiError } from './twitter-api.client';

describe('TwitterApiClient', () => {
  let client: TwitterApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new TwitterApiClient(mockFetch as any);
  });

  it('getMe hits GET /users/me with user.fields and Bearer auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: '123456',
          name: 'Test User',
          username: 'testuser',
          public_metrics: {
            followers_count: 5000,
            following_count: 200,
            tweet_count: 1800,
            listed_count: 10,
          },
        },
      }),
    });

    const user = await client.getMe('fake-bearer-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/users/me');
    expect(url).toContain('user.fields=');
    expect(url).toContain('public_metrics');
    expect(opts.headers.Authorization).toBe('Bearer fake-bearer-token');
    expect(user.id).toBe('123456');
    expect(user.public_metrics.followers_count).toBe(5000);
    expect(user.public_metrics.tweet_count).toBe(1800);
  });

  it('getUserTweets includes expansions and media.fields for attachment metadata', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'tweet1',
            text: 'Hello world',
            created_at: '2024-01-01T12:00:00Z',
            public_metrics: {
              retweet_count: 5,
              reply_count: 2,
              like_count: 42,
              quote_count: 1,
            },
            attachments: { media_keys: ['3_media1'] },
          },
        ],
        includes: {
          media: [
            {
              media_key: '3_media1',
              type: 'photo',
              url: 'https://example.com/img.jpg',
            },
          ],
        },
        meta: { result_count: 1 },
      }),
    });

    const result = await client.getUserTweets({
      userId: '123456',
      accessToken: 'bearer-tok',
      maxResults: 10,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/users/123456/tweets');
    expect(url).toContain('expansions=attachments.media_keys');
    expect(url).toContain('media.fields=');
    expect(opts.headers.Authorization).toBe('Bearer bearer-tok');
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets[0].id).toBe('tweet1');
    // media map should be populated
    expect(result.media.has('3_media1')).toBe(true);
    expect(result.media.get('3_media1')?.url).toBe(
      'https://example.com/img.jpg',
    );
    expect(result.media.get('3_media1')?.type).toBe('photo');
  });

  it('mapCode returns tier_required on 403 with tier-related message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        detail: 'Your access level does not permit Basic tier fields',
      }),
    });

    await expect(client.getMe('tok')).rejects.toMatchObject({
      code: 'tier_required',
      status: 403,
    });
  });

  it('getTweet retries without non_public_metrics on 403 without tier message', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call — non_public requested, return 403
        return {
          ok: false,
          status: 403,
          json: async () => ({ detail: 'Forbidden' }),
        };
      }
      // Second call — public only, succeeds
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 'tweet99',
            text: 'Fallback tweet',
            created_at: '2024-01-01T00:00:00Z',
            public_metrics: {
              retweet_count: 3,
              reply_count: 1,
              like_count: 10,
              quote_count: 0,
            },
          },
        }),
      };
    });

    const tweet = await client.getTweet({
      tweetId: 'tweet99',
      accessToken: 'tok',
      includeNonPublic: true,
    });

    expect(callCount).toBe(2);
    // First call should request non_public_metrics
    const firstUrl = mockFetch.mock.calls[0][0] as string;
    expect(firstUrl).toContain('non_public_metrics');
    // Second call should NOT include non_public_metrics
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).not.toContain('non_public_metrics');
    expect(tweet?.id).toBe('tweet99');
    expect(tweet?.public_metrics?.like_count).toBe(10);
  });
});
