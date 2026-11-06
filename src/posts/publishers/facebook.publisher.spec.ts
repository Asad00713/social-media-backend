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
    Pick<
      FacebookService,
      'postReelToPage' | 'postToPage' | 'postComment' | 'postPhotoStoryToPage'
    >
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
      postPhotoStoryToPage: jest.fn().mockResolvedValue({ postId: 'story-1' }),
    } as any;
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  describe('link post button', () => {
    const link = 'https://lumiere.pk/menu';
    const caption = `Autumn menu is out ${link}.`;
    const post = (
      metadata: Record<string, unknown>,
      over: Partial<PublishOptions> = {},
    ) =>
      publisher.publish(
        options(
          { postType: 'post', ...metadata },
          { content: caption, mediaItems: [], ...over },
        ),
      );

    it('sends the chosen button with the link found in the caption', async () => {
      await post({ linkCta: 'learn' });
      expect(service.postToPage).toHaveBeenCalledWith(
        'page-1',
        'page-token',
        caption,
        link,
        'LEARN_MORE',
        {},
      );
    });

    it('maps each documented choice', async () => {
      await post({ linkCta: 'signup' });
      expect(service.postToPage.mock.calls[0][4]).toBe('SIGN_UP');
    });

    it('is a post exactly as before when no button is chosen', async () => {
      await post({});
      await post({ linkCta: 'none' });
      for (const call of service.postToPage.mock.calls) {
        expect(call).toEqual([
          'page-1',
          'page-token',
          caption,
          undefined,
          undefined,
          {},
        ]);
      }
    });

    it('sends nothing for the choices Facebook does not offer a Page post', async () => {
      await post({ linkCta: 'shop' });
      await post({ linkCta: 'order' });
      await post({ linkCta: 'contact' });
      await post({ linkCta: 'book' });
      expect(service.postToPage).toHaveBeenCalledTimes(4);
      for (const call of service.postToPage.mock.calls) {
        expect(call[3]).toBeUndefined();
        expect(call[4]).toBeUndefined();
      }
    });

    it('sends no button when the caption has no link', async () => {
      await post({ linkCta: 'learn' }, { content: 'just words' });
      expect(service.postToPage.mock.calls[0]).toEqual([
        'page-1',
        'page-token',
        'just words',
        undefined,
        undefined,
        {},
      ]);
    });

    it('is read under the draft’s own key', async () => {
      await post({ callToAction: 'learn' });
      expect(service.postToPage.mock.calls[0][4]).toBeUndefined();
    });

    it('is a link post only: a Reel never sends it', async () => {
      await publisher.publish(
        options({ postType: 'reel', linkCta: 'learn' }, { content: caption }),
      );
      expect(service.postToPage).not.toHaveBeenCalled();
    });

    it('is not sent when there is media: a video is not a link post', async () => {
      await post(
        { linkCta: 'learn' },
        {
          mediaItems: [
            { type: 'video', url: 'https://cdn.example/v.mp4' } as any,
          ],
        },
      );
      expect(service.postToPage).toHaveBeenCalledTimes(1);
      expect(service.postToPage.mock.calls[0][3]).toBeUndefined();
      expect(service.postToPage.mock.calls[0][4]).toBeUndefined();
    });
  });

  describe('Reel cover', () => {
    const cover = 'https://cdn.example/cover.png';
    const reel = (metadata: Record<string, unknown>, over = {}) =>
      publisher.publish(options({ postType: 'reel', ...metadata }, over));

    it('reaches the service as the cover option', async () => {
      await reel({ thumbnailUrl: cover });
      expect(service.postReelToPage).toHaveBeenCalledWith(
        'page-1',
        'page-token',
        'https://cdn.example/v.mp4',
        'a caption',
        { thumbnailUrl: cover },
      );
    });

    it('travels beside the title', async () => {
      await reel({ reelTitle: 'Iced latte', thumbnailUrl: cover });
      expect(service.postReelToPage.mock.calls[0][4]).toEqual({
        title: 'Iced latte',
        thumbnailUrl: cover,
      });
    });

    it('is trimmed, and blank or non-string values are not sent', async () => {
      await reel({ thumbnailUrl: `  ${cover}  ` });
      await reel({ thumbnailUrl: '   ' });
      await reel({ thumbnailUrl: 42 });
      expect(service.postReelToPage.mock.calls[0][4]).toEqual({
        thumbnailUrl: cover,
      });
      expect(service.postReelToPage.mock.calls[1][4]).toEqual({});
      expect(service.postReelToPage.mock.calls[2][4]).toEqual({});
    });

    it('is a Reel setting: a Story and a post never send it', async () => {
      await publisher.publish(
        options(
          { postType: 'story', thumbnailUrl: cover },
          {
            mediaItems: [
              { type: 'image', url: 'https://cdn.example/i.jpg' } as any,
            ],
          },
        ),
      );
      await publisher.publish(
        options({ postType: 'post', thumbnailUrl: cover }, { mediaItems: [] }),
      );
      expect(service.postReelToPage).not.toHaveBeenCalled();
    });

    it('puts a cover that could not be set on the result as a warning', async () => {
      service.postReelToPage.mockResolvedValue({
        postId: 'reel-1',
        thumbnailWarning: 'Video is still processing',
      });
      const result = await reel({ thumbnailUrl: cover });
      expect(result.platformPostId).toBe('reel-1');
      expect(result.metadata?.coverWarning).toBe('Video is still processing');
    });

    it('adds no warning when the cover was set, or none was asked for', async () => {
      // The key must be ABSENT, not present and undefined: a result with
      // `coverWarning: undefined` reads as "something was reported".
      const set = await reel({ thumbnailUrl: cover });
      expect(set.metadata).toBeUndefined();
      const none = await reel({});
      expect(none.metadata).toBeUndefined();
    });

    it('keeps the cover warning beside a first comment’s result', async () => {
      service.postReelToPage.mockResolvedValue({
        postId: 'reel-1',
        thumbnailWarning: 'nope',
      });
      const result = await reel({ thumbnailUrl: cover, firstComment: 'hello' });
      expect(result.metadata).toMatchObject({
        coverWarning: 'nope',
        firstCommentId: 'c-1',
      });
    });
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
