import {
  TIKTOK_PRIVACY_LEVELS,
  TikTokPublisher,
  tiktokPrivacyLevel,
} from './tiktok.publisher';
import { TikTokService } from '../../channels/services/tiktok.service';
import { TikTokQuotaService } from '../../channels/services/tiktok-quota.service';
import { TikTokMediaProxyService } from '../../media/tiktok-media-proxy.service';
import { PublishOptions } from './base.publisher';

/**
 * K1 + K2: TikTok receives what the composer showed.
 *
 * K2 - "Followers" (FOLLOWER_OF_CREATOR) and "Friends" (MUTUAL_FOLLOW_FRIENDS)
 * were both stored as `friends` and both sent as MUTUAL_FOLLOW_FRIENDS.
 * K1 - "Send: To inbox" on a Photo post still published live.
 */
describe('TikTokPublisher - values sent', () => {
  let publisher: TikTokPublisher;
  let service: {
    queryCreatorInfo: jest.Mock;
    postVideoFromUrl: jest.Mock;
    uploadVideoFromUrl: jest.Mock;
    postPhotoFromUrl: jest.Mock;
  };

  const video = (metadata: Record<string, unknown>): PublishOptions =>
    ({
      content: 'caption',
      mediaItems: [{ type: 'video', url: 'https://x/a.mp4' }],
      accessToken: 'tok',
      metadata,
      channelMetadata: {},
      platformAccountId: 'acc',
      channelId: 1,
    }) as unknown as PublishOptions;

  const photo = (metadata: Record<string, unknown>): PublishOptions =>
    ({
      ...video({ postType: 'photo', ...metadata }),
      mediaItems: [
        { type: 'image', url: 'https://x/1.jpg' },
        { type: 'image', url: 'https://x/2.jpg' },
      ],
    }) as unknown as PublishOptions;

  beforeEach(() => {
    service = {
      queryCreatorInfo: jest.fn().mockResolvedValue({ creatorUsername: 'c' }),
      postVideoFromUrl: jest.fn().mockResolvedValue({ publishId: 'v' }),
      uploadVideoFromUrl: jest.fn().mockResolvedValue({ publishId: 'd' }),
      postPhotoFromUrl: jest.fn().mockResolvedValue({ publishId: 'p' }),
    };
    publisher = new TikTokPublisher(
      service as unknown as TikTokService,
      { reserveSlot: jest.fn() } as unknown as TikTokQuotaService,
      {
        mintProxyToken: jest.fn().mockReturnValue('t'),
      } as unknown as TikTokMediaProxyService,
    );
  });

  describe('privacy (K2)', () => {
    it.each(TIKTOK_PRIVACY_LEVELS)(
      'sends a stored %s unchanged',
      async (level) => {
        await publisher.publish(video({ privacy: level }));
        expect(service.postVideoFromUrl.mock.calls[0][2].privacyLevel).toBe(
          level,
        );
      },
    );

    it('Followers is sent as Followers, never as Friends', async () => {
      await publisher.publish(photo({ privacy: 'FOLLOWER_OF_CREATOR' }));
      expect(service.postPhotoFromUrl.mock.calls[0][2].privacyLevel).toBe(
        'FOLLOWER_OF_CREATOR',
      );
    });

    it('still reads the old slugs stored before, as they always published', () => {
      expect(tiktokPrivacyLevel('public')).toBe('PUBLIC_TO_EVERYONE');
      expect(tiktokPrivacyLevel('friends')).toBe('MUTUAL_FOLLOW_FRIENDS');
      expect(tiktokPrivacyLevel('private')).toBe('SELF_ONLY');
      expect(tiktokPrivacyLevel('everyone')).toBeUndefined();
      expect(tiktokPrivacyLevel(undefined)).toBeUndefined();
    });

    it('branded content is still refused with the enum Only me', () => {
      expect(() =>
        publisher.validate(
          video({
            privacy: 'SELF_ONLY',
            brandedContent: true,
            discloseContent: true,
          }),
        ),
      ).toThrow(/private/);
    });
  });

  describe('photo "Send: To inbox" (K1)', () => {
    it('uses MEDIA_UPLOAD when To inbox is chosen', async () => {
      await publisher.publish(
        photo({ privacy: 'PUBLIC_TO_EVERYONE', useDraftUpload: true }),
      );
      expect(service.postPhotoFromUrl.mock.calls[0][2].postMode).toBe(
        'MEDIA_UPLOAD',
      );
    });

    it('posts directly otherwise', async () => {
      await publisher.publish(photo({ privacy: 'PUBLIC_TO_EVERYONE' }));
      expect(service.postPhotoFromUrl.mock.calls[0][2].postMode).toBe(
        'DIRECT_POST',
      );
    });
  });
});
