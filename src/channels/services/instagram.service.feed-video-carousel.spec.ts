/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- fetch double is loosely typed */
import { InstagramService } from './instagram.service';

/**
 * I1: Meta stopped accepting `media_type=VIDEO` on 2023-11-09 — "Use the
 * REELS media type to publish a video to your feed" (Graph API changelog,
 * June 28, 2022 out-of-cycle changes). A one-video Instagram Post went out
 * as VIDEO and failed.
 *
 * I2: "Carousel images are all cropped based on the first image in the
 * carousel" (Content Publishing guide, Limitations). Meta crops mixed
 * ratios itself; refusing them failed carousels Instagram would publish.
 */
describe('InstagramService — feed video and carousel ratios', () => {
  let service: InstagramService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new InstagramService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-1', status_code: 'FINISHED' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const mediaPosts = () =>
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/media') && init?.method === 'POST',
    );

  const formOf = (i: number) =>
    new URLSearchParams(mediaPosts()[i][1].body.toString());

  describe('a feed video (Instagram Business Login)', () => {
    it('is never sent as media_type=VIDEO', async () => {
      // Exactly how the publisher calls it for a one-video Post.
      await service.createVideoPostWithUserToken(
        'user',
        'token',
        'https://cdn.test/v.mp4',
        'caption',
        false,
        undefined,
        {},
      );

      const form = formOf(0);
      expect(form.get('media_type')).toBe('REELS');
      expect(form.get('share_to_feed')).toBe('true');
    });

    it('is shared to the feed even with no settings at all', async () => {
      await service.createVideoPostWithUserToken(
        'user',
        'token',
        'https://cdn.test/v.mp4',
      );

      expect(formOf(0).get('media_type')).toBe('REELS');
      expect(formOf(0).get('share_to_feed')).toBe('true');
    });

    it('a Reel is unchanged: REELS, and Show in feed only when set', async () => {
      await service.createVideoPostWithUserToken(
        'user',
        'token',
        'https://cdn.test/v.mp4',
        'caption',
        false,
        'REELS',
        {},
      );

      expect(formOf(0).get('media_type')).toBe('REELS');
      expect(formOf(0).has('share_to_feed')).toBe(false);
    });
  });

  describe('a feed video (Page-linked account, graph.facebook.com)', () => {
    const body = () => JSON.parse(mediaPosts()[0][1].body as string);

    it('is sent as a reel shared to the feed', async () => {
      await service.createVideoPost('ig', 'page-token', 'https://cdn.test/v.mp4');

      expect(body().media_type).toBe('REELS');
      expect(body().share_to_feed).toBe('true');
    });

    it('a Reel carries no forced share_to_feed', async () => {
      await service.createVideoPost(
        'ig',
        'page-token',
        'https://cdn.test/v.mp4',
        'caption',
        true,
      );

      expect(body().media_type).toBe('REELS');
      expect(body().share_to_feed).toBeUndefined();
    });
  });

  describe('a carousel of images with different ratios', () => {
    const sizes: Record<string, { width: number; height: number }> = {
      'https://cdn.test/wide.jpg': { width: 1600, height: 900 }, // 1.78
      'https://cdn.test/tall.jpg': { width: 1080, height: 1350 }, // 0.80
      'https://cdn.test/too-tall.jpg': { width: 1080, height: 1920 }, // 0.56
    };

    beforeEach(() => {
      jest
        .spyOn(service as any, 'getImageDimensions')
        .mockImplementation(async (url: unknown) => sizes[url as string]);
    });

    // The exact pair that failed live: 1600x900 then 1080x1350.
    it('is published — Meta crops them to the first image', async () => {
      await expect(
        service.createCarouselPostWithUserToken('user', 'token', [
          { type: 'IMAGE', url: 'https://cdn.test/wide.jpg' },
          { type: 'IMAGE', url: 'https://cdn.test/tall.jpg' },
        ]),
      ).resolves.toEqual(expect.objectContaining({ postId: expect.anything() }));

      const parent = mediaPosts()
        .map(([, init]) => new URLSearchParams(init.body.toString()))
        .filter((f) => f.get('media_type') === 'CAROUSEL');
      expect(parent).toHaveLength(1);
    });

    it('still refuses an image outside Instagram’s own 4:5–1.91:1 range', async () => {
      await expect(
        service.createCarouselPostWithUserToken('user', 'token', [
          { type: 'IMAGE', url: 'https://cdn.test/wide.jpg' },
          { type: 'IMAGE', url: 'https://cdn.test/too-tall.jpg' },
        ]),
      ).rejects.toThrow(/too tall/);
    });
  });
});
