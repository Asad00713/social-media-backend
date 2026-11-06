import { Test } from '@nestjs/testing';
import { InstagramPublisher } from './instagram.publisher';
import { InstagramService } from '../../channels/services/instagram.service';

/**
 * The composer's Instagram settings, which travel to the publisher as
 * `metadata` — `platformSpecific` verbatim, so the keys here are the keys the
 * frontend draft writes.
 *
 * What the service does with each one (its parameter name, the container it
 * goes on) is pinned in `instagram.service.container-settings.spec.ts`; this
 * file proves the value reaches the service, and that the guards in
 * `getSettings` drop what Instagram would reject.
 */
describe('InstagramPublisher — container settings from metadata', () => {
  let publisher: InstagramPublisher;
  let createImagePostWithUserToken: jest.Mock;
  let createCarouselPostWithUserToken: jest.Mock;
  let createStoryWithUserToken: jest.Mock;
  let createVideoPostWithUserToken: jest.Mock;

  beforeEach(async () => {
    createImagePostWithUserToken = jest.fn().mockResolvedValue({ postId: '1' });
    createCarouselPostWithUserToken = jest
      .fn()
      .mockResolvedValue({ postId: '1' });
    createStoryWithUserToken = jest.fn().mockResolvedValue({ postId: '1' });
    createVideoPostWithUserToken = jest.fn().mockResolvedValue({ postId: '1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        InstagramPublisher,
        {
          provide: InstagramService,
          useValue: {
            createImagePostWithUserToken,
            createCarouselPostWithUserToken,
            createStoryWithUserToken,
            createVideoPostWithUserToken,
            postCommentWithUserToken: jest.fn(),
          },
        },
      ],
    }).compile();

    publisher = moduleRef.get(InstagramPublisher);
  });

  const image = (name: string) => ({
    type: 'image',
    url: `https://example.test/${name}.jpg`,
  });
  const video = (name: string) => ({
    type: 'video',
    url: `https://example.test/${name}.mp4`,
  });

  const options = (metadata: Record<string, any>, mediaItems: any[]) => ({
    content: 'caption',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  /** The settings object each service method receives, by post type. */
  const imageSettings = () => createImagePostWithUserToken.mock.calls[0][4];
  const reelSettings = () => createVideoPostWithUserToken.mock.calls[0][6];
  const carouselSettings = () =>
    createCarouselPostWithUserToken.mock.calls[0][4];

  describe('the AI label', () => {
    it('reaches a feed image', async () => {
      await publisher.publish(options({ isAiGenerated: true }, [image('a')]));

      expect(imageSettings().isAiGenerated).toBe(true);
    });

    it('reaches a Reel', async () => {
      await publisher.publish(
        options({ postType: 'reel', isAiGenerated: true }, [video('a')]),
      );

      expect(reelSettings().isAiGenerated).toBe(true);
    });

    // The carousel parent is the container that takes it; the service keeps
    // it off the children.
    it('reaches the carousel parent call', async () => {
      await publisher.publish(
        options({ postType: 'carousel', isAiGenerated: true }, [
          image('a'),
          image('b'),
        ]),
      );

      expect(carouselSettings().isAiGenerated).toBe(true);
    });

    // Only a real boolean true switches it on: a draft that stored the
    // string "false" must not declare the post as AI-generated.
    it.each([
      ['false', false],
      ['the string "false"', 'false'],
      ['the string "true"', 'true'],
      ['1', 1],
      ['absent', undefined],
    ])('is dropped when it is %s', async (_label, raw) => {
      await publisher.publish(options({ isAiGenerated: raw }, [image('a')]));

      expect(imageSettings().isAiGenerated).toBeUndefined();
    });

    // A story's container is built from the tags alone (see the tags spec);
    // the composer does not draw the switch on a story, and Meta does not
    // list stories for this parameter.
    it('is not sent on a story', async () => {
      await publisher.publish(
        options({ postType: 'story', isAiGenerated: true }, [image('a')]),
      );

      // Arguments: user, token, url, isVideo, userTags - nothing else.
      expect(createStoryWithUserToken.mock.calls[0]).toHaveLength(5);
    });
  });

  describe('Show in feed', () => {
    const reel = (metadata: Record<string, any>) =>
      publisher.publish(options({ postType: 'reel', ...metadata }, [video('a')]));

    // `false` is a real instruction - it keeps the Reel out of the feed -
    // so it must survive, and must not be invented from an absent value.
    it.each([true, false])('reaches the Reel as %s', async (shareToFeed) => {
      await reel({ shareToFeed });

      expect(reelSettings().shareToFeed).toBe(shareToFeed);
    });

    it.each([
      ['the string "false"', 'false'],
      ['0', 0],
      ['absent', undefined],
    ])('is dropped when it is %s', async (_label, shareToFeed) => {
      await reel({ shareToFeed });

      expect(reelSettings().shareToFeed).toBeUndefined();
    });
  });

  describe('collaborators', () => {
    it('reach a feed image, stripped of the @', async () => {
      await publisher.publish(
        options({ collaborators: [' @ada ', 'grace'] }, [image('a')]),
      );

      expect(imageSettings().collaborators).toEqual(['ada', 'grace']);
    });

    it('reach a Reel', async () => {
      await publisher.publish(
        options({ postType: 'reel', collaborators: ['ada'] }, [video('a')]),
      );

      expect(reelSettings().collaborators).toEqual(['ada']);
    });

    // The carousel parent is the container that takes them; the service
    // keeps them off the children.
    it('reach the carousel parent call', async () => {
      await publisher.publish(
        options({ postType: 'carousel', collaborators: ['ada'] }, [
          image('a'),
          image('b'),
        ]),
      );

      expect(carouselSettings().collaborators).toEqual(['ada']);
    });

    it.each([
      ['not an array', 'ada'],
      ['only blanks and non-strings', ['', '  ', '@', 7, null]],
      ['absent', undefined],
    ])('are dropped when they are %s', async (_label, collaborators) => {
      await publisher.publish(options({ collaborators }, [image('a')]));

      expect(imageSettings().collaborators).toBeUndefined();
    });

    it('keep the strings and drop the rest of a mixed list', async () => {
      await publisher.publish(
        options({ collaborators: ['ada', 7, '', 'grace'] }, [image('a')]),
      );

      expect(imageSettings().collaborators).toEqual(['ada', 'grace']);
    });

    // Meta: "Not supported for Stories". The story call is built from the
    // tags alone.
    it('are not sent on a story', async () => {
      await publisher.publish(
        options({ postType: 'story', collaborators: ['ada'] }, [image('a')]),
      );

      expect(createStoryWithUserToken.mock.calls[0]).toHaveLength(5);
    });
  });

  describe('the Reel cover frame', () => {
    const reel = (metadata: Record<string, any>) =>
      publisher.publish(options({ postType: 'reel', ...metadata }, [video('a')]));

    it('reaches the Reel as whole milliseconds', async () => {
      await reel({ thumbOffset: 2500.4 });

      expect(reelSettings().thumbOffset).toBe(2500);
    });

    it('keeps a zero offset: the first frame is a choice', async () => {
      await reel({ thumbOffset: 0 });

      expect(reelSettings().thumbOffset).toBe(0);
    });

    it.each([
      ['negative', -5],
      ['a string', '2500'],
      ['NaN', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
      ['absent', undefined],
    ])('is dropped when it is %s', async (_label, thumbOffset) => {
      await reel({ thumbOffset });

      expect(reelSettings().thumbOffset).toBeUndefined();
    });
  });

  describe('the Reel audio name', () => {
    const reel = (metadata: Record<string, any>) =>
      publisher.publish(options({ postType: 'reel', ...metadata }, [video('a')]));

    it('reaches the Reel trimmed', async () => {
      await reel({ audioName: '  Morning pour ' });

      expect(reelSettings().audioName).toBe('Morning pour');
    });

    it.each([
      ['blank', '   '],
      ['not a string', 42],
      ['absent', undefined],
    ])('is dropped when it is %s', async (_label, audioName) => {
      await reel({ audioName });

      expect(reelSettings().audioName).toBeUndefined();
    });
  });
});
