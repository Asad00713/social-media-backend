import { YouTubeService } from '../../channels/services/youtube.service';
import type { QuotaTrackerService } from '../../channels/analytics/services/quota-tracker.service';
import { mockFetch } from '../testing/fetch-mock';
import { YoutubeInboxAdapter } from './youtube-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel: ResolvedChannel = {
  id: 1,
  workspaceId: 'w1',
  platform: 'youtube',
  platformAccountId: 'UC1',
  accessToken: 'tok',
  metadata: {},
  username: null,
  accountName: 'Chan',
  profilePictureUrl: null,
};

describe('YoutubeInboxAdapter.moderateDelete', () => {
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  function build(allowed: boolean) {
    const tryConsume = jest.fn().mockResolvedValue({ allowed, remaining: 10 });
    const quota = { tryConsume } as unknown as QuotaTrackerService;
    return {
      tryConsume,
      adapter: new YoutubeInboxAdapter(new YouTubeService(quota)),
    };
  }

  it('rejects the comment through comments/setModerationStatus and reserves 50 inbox units', async () => {
    net = mockFetch();
    const { tryConsume, adapter } = build(true);
    await adapter.moderateDelete(channel, 'yt-c1');
    expect(tryConsume).toHaveBeenCalledWith('youtube', 50, 'inbox');
    expect(net.requests).toHaveLength(1);
    const req = net.requests[0];
    expect(req.method).toBe('POST');
    expect(req.headers).toMatchObject({ Authorization: 'Bearer tok' });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(
      'https://www.googleapis.com/youtube/v3/comments/setModerationStatus',
    );
    expect(url.searchParams.get('id')).toBe('yt-c1');
    expect(url.searchParams.get('moderationStatus')).toBe('rejected');
  });

  it('does not call YouTube when the quota is exhausted', async () => {
    net = mockFetch();
    const { adapter } = build(false);
    await expect(adapter.moderateDelete(channel, 'yt-c1')).rejects.toThrow(
      /quota exhausted/,
    );
    expect(net.requests).toHaveLength(0);
  });
});
