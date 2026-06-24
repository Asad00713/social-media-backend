import { YouTubeAnalyticsAdapter } from './youtube-analytics.adapter';
import {
  YouTubeDataApiClient,
  YouTubeApiError,
} from './youtube-data-api.client';
import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

describe('YouTubeAnalyticsAdapter', () => {
  const dataClient = {
    getChannelById: jest.fn(),
    listChannelVideos: jest.fn(),
    getVideosByIds: jest.fn(),
  };
  const analyticsClient = { getVideoMetrics: jest.fn() };
  let adapter: YouTubeAnalyticsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new YouTubeAnalyticsAdapter(
      dataClient as unknown as YouTubeDataApiClient,
      analyticsClient as unknown as YouTubeAnalyticsApiClient,
    );
  });

  it('exposes platform=youtube + subscribers vocab', () => {
    expect(adapter.platform).toBe('youtube');
    expect(adapter.capabilities.vocabulary.follower).toBe('subscribers');
  });

  it('estimateQuotaCost returns expected costs', () => {
    expect(adapter.estimateQuotaCost('fetchProfileSnapshot')).toBe(2);
    expect(adapter.estimateQuotaCost('fetchPostMetrics')).toBe(1);
    expect(adapter.estimateQuotaCost('fetchRecentPosts')).toBe(101);
  });

  it('fetchProfileSnapshot success returns mapped metrics', async () => {
    dataClient.getChannelById.mockResolvedValue({
      items: [
        {
          id: 'UC123',
          snippet: { title: 'Test', description: 'desc' },
          statistics: {
            subscriberCount: '12000',
            viewCount: '450000',
            videoCount: '42',
          },
        },
      ],
    });
    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'UC123',
      accessToken: 'tok',
    } as any);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.followersCount).toBe(12000);
      expect(result.data.totalPostsCount).toBe(42);
      expect(result.data.platformMetrics.viewCount).toBe(450000);
    }
  });

  it('fetchProfileSnapshot returns not_found when items empty', async () => {
    dataClient.getChannelById.mockResolvedValue({ items: [] });
    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'UC123',
      accessToken: 'tok',
    } as any);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('not_found');
    }
  });

  it('fetchProfileSnapshot returns failed on YouTubeApiError', async () => {
    dataClient.getChannelById.mockRejectedValue(
      new YouTubeApiError('rate_limited', 403, 'quota'),
    );
    const result = await adapter.fetchProfileSnapshot({
      platformAccountId: 'UC123',
      accessToken: 'tok',
    } as any);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('rate_limited');
    }
  });
});
