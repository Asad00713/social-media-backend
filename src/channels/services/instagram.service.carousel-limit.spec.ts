/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- fetch double is loosely typed */
import { Test } from '@nestjs/testing';
import {
  INSTAGRAM_CAROUSEL_MAX_ITEMS,
  InstagramService,
} from './instagram.service';
import { InstagramPublisher } from '../../posts/publishers/instagram.publisher';

/**
 * Instagram's carousel limit is 20, not 10.
 *
 * Content Publishing guide, Limitations: "Carousels are limited to 20
 * images, videos, or a mix of the two." IG User Media reference,
 * `children`: "An array of up to 20 container IDs". Both the service and
 * the publisher refused items 11 to 20, which Instagram would publish.
 */
describe('Instagram carousel limit', () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'IMAGE' as const,
      url: `https://cdn.test/${i}.jpg`,
    }));

  it('is Meta’s 20', () => {
    expect(INSTAGRAM_CAROUSEL_MAX_ITEMS).toBe(20);
  });

  describe('InstagramService.createCarouselPostWithUserToken', () => {
    let service: InstagramService;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      service = new InstagramService();
      fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'container-1', status_code: 'FINISHED' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      jest
        .spyOn(service as any, 'getImageDimensions')
        .mockResolvedValue({ width: 1080, height: 1080 });
    });

    const childPosts = () =>
      fetchMock.mock.calls
        .filter(
          ([url, init]) =>
            String(url).endsWith('/media') && init?.method === 'POST',
        )
        .map(([, init]) => new URLSearchParams(init.body.toString()))
        .filter((f) => f.get('is_carousel_item') === 'true');

    it('publishes 20 items, one child container each', async () => {
      await expect(
        service.createCarouselPostWithUserToken('user', 'token', items(20)),
      ).resolves.toEqual(expect.objectContaining({ postId: expect.anything() }));

      expect(childPosts()).toHaveLength(20);
    });

    it('refuses a 21st item before calling Meta', async () => {
      await expect(
        service.createCarouselPostWithUserToken('user', 'token', items(21)),
      ).rejects.toThrow('between 2 and 20');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('InstagramPublisher.validate', () => {
    let publisher: InstagramPublisher;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          InstagramPublisher,
          { provide: InstagramService, useValue: {} },
        ],
      }).compile();
      publisher = moduleRef.get(InstagramPublisher);
    });

    const options = (postType: string, n: number) => ({
      content: 'caption',
      mediaItems: items(n).map((m) => ({ type: 'image', url: m.url })),
      accessToken: 'token',
      platformAccountId: 'acct',
      channelMetadata: {},
      channelId: 1,
      metadata: { postType },
    });

    it.each(['carousel', 'feed'])('takes 20 items on a %s', (postType) => {
      expect(() => publisher.validate(options(postType, 20) as any)).not.toThrow();
    });

    it.each(['carousel', 'feed'])('refuses 21 items on a %s', (postType) => {
      expect(() => publisher.validate(options(postType, 21) as any)).toThrow(
        /20 media items/,
      );
    });
  });
});
