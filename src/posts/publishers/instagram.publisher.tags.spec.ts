import { Test } from '@nestjs/testing';
import { InstagramPublisher } from './instagram.publisher';
import { InstagramService } from '../../channels/services/instagram.service';

/**
 * `user_tags`, which the composer has been writing for a while and nothing
 * read: the photo editor's "Tagged on this photo" panel stores a username
 * and a point on each MEDIA ITEM.
 *
 * Per-item is also what Instagram's API wants — on a carousel `user_tags`
 * goes on each item container while the caption and collaborators go on
 * the parent — so the two agree and the asymmetry below is theirs, not
 * ours.
 */
describe('InstagramPublisher — tagged people', () => {
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

  const photo = (name: string, tags?: unknown[]) => ({
    type: 'image',
    url: `https://example.test/${name}.jpg`,
    ...(tags ? { tags } : {}),
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

  it('sends the tags written on a single photo', async () => {
    await publisher.publish(
      options({}, [photo('a', [{ username: 'ada', x: 0.2, y: 0.8 }])]),
    );

    expect(createImagePostWithUserToken.mock.calls[0][4].userTags).toEqual([
      { username: 'ada', x: 0.2, y: 0.8 },
    ]);
  });

  it.each([
    ['no tags were written', undefined],
    ['the list is empty', []],
    ['a tag has no username', [{ x: 0.1, y: 0.1 }]],
    ['a username is blank', [{ username: '  ', x: 0.1, y: 0.1 }]],
  ])('sends no tags when %s', async (_label, tags) => {
    await publisher.publish(options({}, [photo('a', tags as unknown[])]));

    expect(
      createImagePostWithUserToken.mock.calls[0][4].userTags,
    ).toBeUndefined();
  });

  // The asymmetry, which is Instagram's: each slide tags the people in
  // THAT picture, so the tags cannot be hoisted to the post.
  it('keeps each slide tags on its own slide', async () => {
    await publisher.publish(
      options({ postType: 'carousel' }, [
        photo('a', [{ username: 'ada', x: 0.1, y: 0.1 }]),
        photo('b', [{ username: 'grace', x: 0.9, y: 0.9 }]),
      ]),
    );

    const [, , items] = createCarouselPostWithUserToken.mock.calls[0];
    expect(items[0].userTags).toEqual([{ username: 'ada', x: 0.1, y: 0.1 }]);
    expect(items[1].userTags).toEqual([
      { username: 'grace', x: 0.9, y: 0.9 },
    ]);
  });

  // A story mention IS `user_tags` — not the sticker API, which Meta does
  // not expose. Stories take no collaborators and no `share_to_feed`, so
  // the story call receives the tags alone.
  it('sends a story mention as the tags', async () => {
    await publisher.publish(
      options({ postType: 'story' }, [
        photo('a', [{ username: 'ada', x: 0.5, y: 0.5 }]),
      ]),
    );

    expect(createStoryWithUserToken.mock.calls[0][4]).toEqual([
      { username: 'ada', x: 0.5, y: 0.5 },
    ]);
  });
});
