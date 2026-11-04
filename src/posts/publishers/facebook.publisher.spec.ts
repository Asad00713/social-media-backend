import { FacebookPublisher } from './facebook.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { PublishOptions } from './base.publisher';

/**
 * `platformSpecific` reaches this publisher as `metadata` VERBATIM, so each
 * key the composer writes has to be read here under exactly that name. These
 * tests pin the names and prove each value reaches the service call; the
 * service spec pins where it goes in the request.
 */
describe('FacebookPublisher', () => {
  let publisher: FacebookPublisher;
  let service: jest.Mocked<
    Pick<FacebookService, 'postReelToPage' | 'postToPage' | 'postComment'>
  >;

  const options = (
    metadata: Record<string, unknown>,
    over: Partial<PublishOptions> = {},
  ): PublishOptions =>
    ({
      content: 'a caption',
      mediaItems: [{ type: 'video', url: 'https://cdn.example/v.mp4' } as any],
      accessToken: 'page-token',
      metadata,
      channelMetadata: {},
      platformAccountId: 'page-1',
      channelId: 1,
      ...over,
    }) as PublishOptions;

  beforeEach(() => {
    service = {
      postReelToPage: jest.fn().mockResolvedValue({ postId: 'reel-1' }),
      postToPage: jest.fn().mockResolvedValue({ postId: 'post-1' }),
      postComment: jest.fn().mockResolvedValue({ commentId: 'c-1' }),
    } as any;
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  describe('Reel title', () => {
    const reel = (metadata: Record<string, unknown>) =>
      publisher.publish(options({ postType: 'reel', ...metadata }));

    it('reaches the service as the title option', async () => {
      await reel({ reelTitle: 'Iced Spanish latte' });

      expect(service.postReelToPage).toHaveBeenCalledWith(
        'page-1',
        'page-token',
        'https://cdn.example/v.mp4',
        'a caption',
        { title: 'Iced Spanish latte' },
      );
    });

    it('is trimmed, and a blank title is not sent at all', async () => {
      await reel({ reelTitle: '  Iced Spanish latte  ' });
      expect(service.postReelToPage.mock.calls[0][4]).toEqual({
        title: 'Iced Spanish latte',
      });

      await reel({ reelTitle: '   ' });
      expect(service.postReelToPage.mock.calls[1][4]).toEqual({});
    });

    it('is ignored when it is not a string', async () => {
      await reel({ reelTitle: 42 });
      expect(service.postReelToPage.mock.calls[0][4]).toEqual({});
    });

    it('is read under its own key, not a generic `title`', async () => {
      await reel({ title: 'not this one' });
      expect(service.postReelToPage.mock.calls[0][4]).toEqual({});
    });
  });
});
