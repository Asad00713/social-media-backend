/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

import { FacebookService } from './facebook.service';

/**
 * F2: every photo of a Facebook Post goes out, not just the first - each
 * uploaded with `published=false`, then one `/feed` post with
 * `attached_media` (Page Photos reference, "Creating" examples).
 * S5: each photo carries `alt_text_custom`.
 * F1: a feed video carries `backdated_post` and `targeting`.
 */
describe('FacebookService — photos, alt text and video options', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;
  let photoId: number;
  const realFetch = global.fetch;

  beforeEach(() => {
    photoId = 0;
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/photos')) {
        photoId += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `ph${photoId}` }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'page_post1' }),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const jsonCalls = (suffix: string) =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(suffix))
      .map(([, init]) => JSON.parse(init.body as string));

  describe('postPhotosToPage', () => {
    it('uploads each photo unpublished, then attaches them all, in order', async () => {
      const result = await service.postPhotosToPage(
        'page-1',
        'tok',
        [
          { url: 'https://cdn.test/1.jpg', altText: ' Beans ' },
          { url: 'https://cdn.test/2.jpg' },
          { url: 'https://cdn.test/3.jpg', altText: 'Cup' },
        ],
        'New roast',
        { backdatedTime: 1700000000, targeting: { age_min: 18 }, place: '123' },
      );

      const photos = jsonCalls('/page-1/photos');
      expect(photos.map((p) => p.url)).toEqual([
        'https://cdn.test/1.jpg',
        'https://cdn.test/2.jpg',
        'https://cdn.test/3.jpg',
      ]);
      expect(photos.every((p) => p.published === 'false')).toBe(true);
      expect(photos.map((p) => p.alt_text_custom)).toEqual([
        'Beans',
        undefined,
        'Cup',
      ]);

      const [feed] = jsonCalls('/page-1/feed');
      expect(feed.attached_media).toEqual([
        { media_fbid: 'ph1' },
        { media_fbid: 'ph2' },
        { media_fbid: 'ph3' },
      ]);
      expect(feed.message).toBe('New roast');
      // The post-level options ride the feed post, which is what publishes.
      expect(feed.backdated_time).toBe('1700000000');
      expect(feed.targeting).toBe('{"age_min":18}');
      expect(feed.place).toBe('123');
      expect(photos.some((p) => 'place' in p)).toBe(false);
      expect(result).toEqual({ postId: 'page_post1' });
    });

    it('stops before the feed post when a photo is refused', async () => {
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ id: 'ph1' }),
      }));
      fetchMock.mockImplementationOnce(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Invalid image' } }),
      }));
      await expect(
        service.postPhotosToPage(
          'page-1',
          'tok',
          [
            { url: 'https://cdn.test/1.jpg' },
            { url: 'https://cdn.test/2.jpg' },
          ],
          'x',
        ),
      ).rejects.toThrow(/photo 2 of 2: Invalid image/);
      expect(jsonCalls('/page-1/feed')).toHaveLength(0);
    });
  });

  it('postPhotoToPage sends alt_text_custom when given, not otherwise', async () => {
    await service.postPhotoToPage(
      'page-1',
      'tok',
      'https://cdn.test/1.jpg',
      'c',
      {
        altText: 'Beans',
      },
    );
    await service.postPhotoToPage(
      'page-1',
      'tok',
      'https://cdn.test/1.jpg',
      'c',
    );
    const [withAlt, without] = jsonCalls('/page-1/photos');
    expect(withAlt.alt_text_custom).toBe('Beans');
    expect('alt_text_custom' in without).toBe(false);
  });

  it('postVideoToPage sends backdated_post and targeting', async () => {
    await service.postVideoToPage(
      'page-1',
      'tok',
      'https://cdn.test/v.mp4',
      'd',
      {
        backdatedTime: 1700000000,
        targeting: { age_min: 21 },
      },
    );
    const form = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/page-1/videos'),
    )![1].body as FormData;
    expect(form.get('backdated_post')).toBe('{"backdated_time":1700000000}');
    expect(form.get('targeting')).toBe('{"age_min":21}');
    expect(form.has('place')).toBe(false);
  });

  it('postVideoToPage sends neither when unset', async () => {
    await service.postVideoToPage(
      'page-1',
      'tok',
      'https://cdn.test/v.mp4',
      'd',
    );
    const form = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/page-1/videos'),
    )![1].body as FormData;
    expect(form.has('backdated_post')).toBe(false);
    expect(form.has('targeting')).toBe(false);
  });
});
