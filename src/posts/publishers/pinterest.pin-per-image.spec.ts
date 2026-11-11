import { PinterestPublisher } from './pinterest.publisher';
import { PartialPublishError, PublishOptions } from './base.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';

/**
 * Several images that are not an explicit carousel publish as one Pin EACH.
 *
 * A channel holds one platformPostId, so the publisher returns the first
 * image's Pin there and every Pin in `itemResults`. What makes this safe is
 * the retry: a Pin that went out must not go out again, so an image already
 * in `previousItemResults` is skipped, and a failure part-way reports the
 * Pins that did go out (PartialPublishError) so the caller can store them.
 */
describe('PinterestPublisher - one Pin per image', () => {
  let createPin: jest.Mock;
  let publisher: PinterestPublisher;

  const image = (name: string, altText?: string) => ({
    type: 'image',
    url: `https://cdn.test/${name}.jpg`,
    ...(altText ? { altText } : {}),
  });

  const options = (
    over: Partial<PublishOptions> = {},
    metadata: Record<string, unknown> = {},
  ): PublishOptions =>
    ({
      content: 'body',
      mediaItems: [image('a', 'Alt A'), image('b', 'Alt B'), image('c')],
      accessToken: 'tok',
      platformAccountId: 'acct',
      channelMetadata: {},
      channelId: 1,
      metadata: {
        boardId: 'board-1',
        title: 'Iced latte',
        // The Pin's own Description field: the shared caption (`content`)
        // is never a Pin's description (pinterest.description.spec.ts).
        description: 'Pin body',
        destinationLink: 'https://lumiere.pk',
        boardSectionId: 'sec-1',
        aiModified: true,
        ...metadata,
      },
      ...over,
    }) as PublishOptions;

  beforeEach(() => {
    let n = 0;
    createPin = jest.fn().mockImplementation(async () => {
      n += 1;
      return {
        pinId: `pin-${n}`,
        pinUrl: `https://pinterest.com/pin/pin-${n}/`,
      };
    });
    publisher = new PinterestPublisher({
      createPin,
    } as unknown as PinterestService);
  });

  const urlOf = (call: number) => createPin.mock.calls[call][4];
  const optionsOf = (call: number) => createPin.mock.calls[call][5];

  it('creates one Pin per image, in order, each with its own image', async () => {
    await publisher.publish(options());
    expect(createPin).toHaveBeenCalledTimes(3);
    expect([urlOf(0), urlOf(1), urlOf(2)]).toEqual([
      'https://cdn.test/a.jpg',
      'https://cdn.test/b.jpg',
      'https://cdn.test/c.jpg',
    ]);
  });

  it('gives every Pin the shared settings and its OWN alt text, and no carousel', async () => {
    await publisher.publish(options());
    for (let i = 0; i < 3; i++) {
      expect(createPin.mock.calls[i].slice(0, 4)).toEqual([
        'tok',
        'board-1',
        'Iced latte',
        'Pin body',
      ]);
      expect(optionsOf(i)).toMatchObject({
        link: 'https://lumiere.pk',
        boardSectionId: 'sec-1',
        aiModified: true,
        mediaType: 'image',
      });
      expect(optionsOf(i).extraImageUrls).toBeUndefined();
    }
    expect(optionsOf(0).altText).toBe('Alt A');
    expect(optionsOf(1).altText).toBe('Alt B');
    expect(optionsOf(2).altText).toBeUndefined();
  });

  it('reports the FIRST Pin as the channel’s post, and every Pin as an item', async () => {
    const result = await publisher.publish(options());
    expect(result.platformPostId).toBe('pin-1');
    expect(result.platformPostUrl).toBe('https://pinterest.com/pin/pin-1/');
    expect(result.itemResults).toEqual([
      {
        mediaUrl: 'https://cdn.test/a.jpg',
        platformPostId: 'pin-1',
        platformPostUrl: 'https://pinterest.com/pin/pin-1/',
      },
      {
        mediaUrl: 'https://cdn.test/b.jpg',
        platformPostId: 'pin-2',
        platformPostUrl: 'https://pinterest.com/pin/pin-2/',
      },
      {
        mediaUrl: 'https://cdn.test/c.jpg',
        platformPostId: 'pin-3',
        platformPostUrl: 'https://pinterest.com/pin/pin-3/',
      },
    ]);
  });

  it('stops at a failure and reports the Pins that DID go out', async () => {
    createPin
      .mockResolvedValueOnce({ pinId: 'pin-1', pinUrl: 'u1' })
      .mockRejectedValueOnce(new Error('Rate limited'));
    const err = await publisher.publish(options()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialPublishError);
    expect((err as PartialPublishError).message).toBe('Rate limited');
    expect((err as PartialPublishError).itemResults).toEqual([
      {
        mediaUrl: 'https://cdn.test/a.jpg',
        platformPostId: 'pin-1',
        platformPostUrl: 'u1',
      },
    ]);
    expect(createPin).toHaveBeenCalledTimes(2);
  });

  it('fails exactly as a single Pin does when the FIRST image fails', async () => {
    const boom = new Error('401 invalid token');
    createPin.mockRejectedValueOnce(boom);
    const err = await publisher.publish(options()).catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it('on a retry, skips the images that already went out and keeps their Pins', async () => {
    const previous = [
      {
        mediaUrl: 'https://cdn.test/a.jpg',
        platformPostId: 'old-1',
        platformPostUrl: 'o1',
      },
    ];
    const result = await publisher.publish(
      options({ previousItemResults: previous }),
    );
    expect(createPin).toHaveBeenCalledTimes(2);
    expect([urlOf(0), urlOf(1)]).toEqual([
      'https://cdn.test/b.jpg',
      'https://cdn.test/c.jpg',
    ]);
    expect(result.platformPostId).toBe('old-1');
    expect(result.itemResults?.map((r) => r.platformPostId)).toEqual([
      'old-1',
      'pin-1',
      'pin-2',
    ]);
  });

  it('matches earlier Pins by image, not position, so a reorder does not skip the wrong one', async () => {
    const previous = [
      { mediaUrl: 'https://cdn.test/c.jpg', platformPostId: 'old-c' },
    ];
    await publisher.publish(options({ previousItemResults: previous }));
    expect(createPin.mock.calls.map((c) => c[4])).toEqual([
      'https://cdn.test/a.jpg',
      'https://cdn.test/b.jpg',
    ]);
  });

  it('carries earlier Pins into a second failure, so nothing is ever lost', async () => {
    const previous = [
      { mediaUrl: 'https://cdn.test/a.jpg', platformPostId: 'old-1' },
    ];
    createPin.mockRejectedValueOnce(new Error('still down'));
    const err = (await publisher
      .publish(options({ previousItemResults: previous }))
      .catch((e: unknown) => e)) as PartialPublishError;
    expect(err).toBeInstanceOf(PartialPublishError);
    expect(err.itemResults).toEqual(previous);
  });

  it('is still ONE carousel Pin when the carousel is chosen', async () => {
    const result = await publisher.publish(options({}, { asCarousel: true }));
    expect(createPin).toHaveBeenCalledTimes(1);
    expect(optionsOf(0).extraImageUrls).toEqual([
      'https://cdn.test/b.jpg',
      'https://cdn.test/c.jpg',
    ]);
    expect(result.itemResults).toBeUndefined();
  });

  it('is still one Pin for a single image', async () => {
    const result = await publisher.publish(
      options({ mediaItems: [image('a')] as any }),
    );
    expect(createPin).toHaveBeenCalledTimes(1);
    expect(result.itemResults).toBeUndefined();
  });
});
