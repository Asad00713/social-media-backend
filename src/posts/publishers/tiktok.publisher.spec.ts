import { TikTokPublisher } from './tiktok.publisher';
import { TikTokService } from '../../channels/services/tiktok.service';
import { TikTokQuotaService } from '../../channels/services/tiktok-quota.service';
import { TikTokMediaProxyService } from '../../media/tiktok-media-proxy.service';
import { PublishOptions } from './base.publisher';

/**
 * Focused on the video publish path (Bug A): the default MUST be TikTok Direct
 * Post (postVideoFromUrl → /post/publish/video/init/), which lands on the
 * creator's profile with the privacy they chose. The Creator Inbox draft path
 * (uploadVideoFromUrl → /post/publish/inbox/video/init/) is opt-in only.
 */
describe('TikTokPublisher video publish path', () => {
  let publisher: TikTokPublisher;
  let tiktokService: jest.Mocked<Pick<
    TikTokService,
    'queryCreatorInfo' | 'postVideoFromUrl' | 'uploadVideoFromUrl'
  >>;
  let quotaService: jest.Mocked<Pick<TikTokQuotaService, 'reserveSlot'>>;
  let mediaProxy: jest.Mocked<Pick<TikTokMediaProxyService, 'mintProxyToken'>>;

  const baseOptions = (metadata: Record<string, any>): PublishOptions =>
    ({
      content: 'hello',
      mediaItems: [
        {
          type: 'video',
          url: 'https://res.cloudinary.com/x/video/upload/v1/a.mp4',
        } as any,
      ],
      accessToken: 'tok',
      metadata,
      channelMetadata: {},
      platformAccountId: 'acc-1',
      channelId: 1,
    }) as PublishOptions;

  beforeEach(() => {
    tiktokService = {
      queryCreatorInfo: jest.fn().mockResolvedValue({ creatorUsername: 'bob' }),
      postVideoFromUrl: jest.fn().mockResolvedValue({ publishId: 'direct-1' }),
      uploadVideoFromUrl: jest.fn().mockResolvedValue({ publishId: 'draft-1' }),
    } as any;
    quotaService = { reserveSlot: jest.fn().mockResolvedValue(undefined) } as any;
    mediaProxy = { mintProxyToken: jest.fn().mockReturnValue('signed-token') } as any;

    publisher = new TikTokPublisher(
      tiktokService as unknown as TikTokService,
      quotaService as unknown as TikTokQuotaService,
      mediaProxy as unknown as TikTokMediaProxyService,
    );
  });

  it('defaults to Direct Post (postVideoFromUrl) when no draft flag is set', async () => {
    const result = await publisher.publish(baseOptions({ privacy: 'private' }));

    expect(tiktokService.postVideoFromUrl).toHaveBeenCalledTimes(1);
    expect(tiktokService.uploadVideoFromUrl).not.toHaveBeenCalled();
    expect(result.platformPostId).toBe('direct-1');
  });

  it('sends the video through the verified media proxy URL for Direct Post', async () => {
    await publisher.publish(baseOptions({ privacy: 'public' }));

    const [, videoUrl] = tiktokService.postVideoFromUrl.mock.calls[0];
    expect(mediaProxy.mintProxyToken).toHaveBeenCalledWith(
      'https://res.cloudinary.com/x/video/upload/v1/a.mp4',
    );
    expect(videoUrl).toContain('/api/tiktok-media/signed-token');
  });

  it('honors the user-selected privacy in the Direct Post call', async () => {
    await publisher.publish(baseOptions({ privacy: 'public' }));

    const [, , opts] = tiktokService.postVideoFromUrl.mock.calls[0];
    expect(opts.privacyLevel).toBe('PUBLIC_TO_EVERYONE');
  });

  it('uses the Inbox draft path only when useDraftUpload is explicitly true', async () => {
    const result = await publisher.publish(
      baseOptions({ privacy: 'private', useDraftUpload: true }),
    );

    expect(tiktokService.uploadVideoFromUrl).toHaveBeenCalledTimes(1);
    expect(tiktokService.postVideoFromUrl).not.toHaveBeenCalled();
    expect(result.platformPostId).toBe('draft-1');
  });
});
