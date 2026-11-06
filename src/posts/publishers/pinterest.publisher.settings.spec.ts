import { Test } from '@nestjs/testing';
import { PinterestPublisher } from './pinterest.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';

/**
 * What the publisher hands the service. The service's own spec covers the
 * request body; this covers the translation from composer metadata, and
 * in particular which media become a carousel.
 */
describe('PinterestPublisher — pin settings', () => {
  let publisher: PinterestPublisher;
  let createPin: jest.Mock;

  beforeEach(async () => {
    createPin = jest.fn().mockResolvedValue({ pinId: 'pin-1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PinterestPublisher,
        { provide: PinterestService, useValue: { createPin } },
      ],
    }).compile();

    publisher = moduleRef.get(PinterestPublisher);
  });

  const image = (name: string) => ({
    type: 'image',
    url: `https://example.test/${name}.jpg`,
  });

  const options = (metadata: Record<string, any>, mediaItems: any[]) => ({
    content: 'body',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata: { boardId: 'board-1', title: 'Title', ...metadata },
  });

  /** The options object handed to createPin. */
  const passed = () => createPin.mock.calls[0][5];

  describe('where alt text comes from', () => {
    // The real source. The composer writes alt text on each MEDIA ITEM,
    // in the photo editor; the Pinterest panel's row is read-only and
    // says "From each photo". Reading only `metadata.altText` would have
    // forwarded a field that is always empty.
    it('takes the alt text set on the pinned photo', async () => {
      await publisher.publish(
        options({}, [{ ...image('a'), altText: '  A flat white  ' }]),
      );

      expect(passed().altText).toBe('A flat white');
    });

    it('lets the panel override it', async () => {
      await publisher.publish(
        options({ altText: 'From the panel' }, [
          { ...image('a'), altText: 'From the photo' },
        ]),
      );

      expect(passed().altText).toBe('From the panel');
    });

    // A pin takes one `alt_text`, and a carousel's items carry only a
    // url — so the first image's is the one that applies.
    it('uses the first image on a carousel', async () => {
      await publisher.publish(
        options({ asCarousel: true }, [
          { ...image('a'), altText: 'First' },
          { ...image('b'), altText: 'Second' },
        ]),
      );

      expect(passed().altText).toBe('First');
    });

    it.each([
      ['nothing set it', {}, [image('a')]],
      ['the photo has blank alt text', {}, [{ ...image('a'), altText: '  ' }]],
      ['the panel value is blank', { altText: '   ' }, [image('a')]],
    ])('sends none when %s', async (_label, metadata, media) => {
      await publisher.publish(options(metadata, media));

      expect(passed().altText).toBeUndefined();
    });
  });

  it('forwards the AI disclosure only when true', async () => {
    await publisher.publish(options({ aiModified: true }, [image('a')]));
    expect(passed().aiModified).toBe(true);

    createPin.mockClear();
    await publisher.publish(options({ aiModified: 'yes' }, [image('a')]));
    expect(passed().aiModified).toBe(false);
  });

  it('forwards the board section', async () => {
    await publisher.publish(
      options({ boardSectionId: 'section-9' }, [image('a')]),
    );

    expect(passed().boardSectionId).toBe('section-9');
  });

  describe('which media become a carousel', () => {
    it('passes no extras for a single image', async () => {
      await publisher.publish(options({}, [image('a')]));

      expect(passed().extraImageUrls).toEqual([]);
    });

    it('passes the rest of the images as extras', async () => {
      await publisher.publish(
        options({ asCarousel: true }, [image('a'), image('b'), image('c')]),
      );

      expect(passed().extraImageUrls).toEqual([
        'https://example.test/b.jpg',
        'https://example.test/c.jpg',
      ]);
    });

    // The composer's other mode, "N separate Pins", needs the
    // orchestrator to publish once per image — it publishes once per
    // CHANNEL. Until it does, that choice must not silently become a
    // carousel: the author picked the opposite of one.
    it.each([
      ['the separate-Pins mode is chosen', { asCarousel: false }],
      ['no mode was chosen', {}],
    ])('passes no extras when %s', async (_label, metadata) => {
      await publisher.publish(
        options(metadata, [image('a'), image('b'), image('c')]),
      );

      expect(passed().extraImageUrls).toEqual([]);
    });

    // The union has no mixed-media carousel variant, so a video among the
    // extras has to be dropped rather than sent as an image url.
    it('drops a video from the extras', async () => {
      await publisher.publish(
        options({ asCarousel: true }, [
          image('a'),
          { type: 'video', url: 'https://example.test/v.mp4' },
          image('c'),
        ]),
      );

      expect(passed().extraImageUrls).toEqual(['https://example.test/c.jpg']);
    });

    // A video pin is its own upload flow entirely — there is no carousel
    // to build, whatever else is attached.
    it('passes no extras when the first item is a video', async () => {
      await publisher.publish(
        options({ asCarousel: true }, [
          { type: 'video', url: 'https://example.test/v.mp4' },
          image('b'),
        ]),
      );

      expect(passed().extraImageUrls).toEqual([]);
    });
  });
});
