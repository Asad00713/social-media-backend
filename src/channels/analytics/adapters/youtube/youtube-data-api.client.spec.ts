import { YouTubeDataApiClient } from './youtube-data-api.client';

describe('YouTubeDataApiClient', () => {
  let client: YouTubeDataApiClient;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    client = new YouTubeDataApiClient(mockFetch as any);
  });

  it('getChannelById hits channels.list with snippet,statistics,contentDetails parts', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'UC123', snippet: { title: 'Test' } }] }),
    });
    await client.getChannelById('UC123', 'fake-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/channels?');
    expect(url).toContain('id=UC123');
    expect(url).toContain('part=snippet%2Cstatistics%2CcontentDetails');
    expect(opts.headers.Authorization).toBe('Bearer fake-token');
  });

  it('listChannelVideos hits search.list filtered by channelId', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    await client.listChannelVideos('UC123', 'fake-token', { maxResults: 25 });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/search?');
    expect(url).toContain('channelId=UC123');
    expect(url).toContain('type=video');
    expect(url).toContain('maxResults=25');
  });

  it('throws YouTubeApiError with rate_limited code on 403 quota response', async () => {
    mockFetch.mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'quotaExceeded' } }),
    });
    await expect(client.getChannelById('UC123', 'fake-token'))
      .rejects.toMatchObject({ code: 'rate_limited', status: 403 });
  });
});
