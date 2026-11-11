import { LinkedInService } from './linkedin.service';

// The media download goes through the SSRF-guarded fetchPublicMedia; route
// it back to the stub (the guard is covered in public-fetch.spec).
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string) => global.fetch(url),
}));

/**
 * Three things every Posts API request has to get right, pinned on the
 * REQUEST because each failed silently on LinkedIn's side:
 *  - `commentary` is little text: a caption published live was cut at its
 *    first "(";
 *  - several photos are a `multiImage` post: a 2-photo post published one;
 *  - each picture's alt text reaches LinkedIn (`altText`).
 */
describe('LinkedInService - little text, multi-image and alt text', () => {
  let service: LinkedInService;
  let fetchMock: jest.Mock;
  let imageCount: number;

  const headersOf = (map: Record<string, string | null>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  beforeEach(() => {
    service = new LinkedInService();
    imageCount = 0;
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/rest/posts')) {
        return {
          ok: true,
          status: 201,
          headers: headersOf({ 'x-restli-id': 'urn:li:share:1' }),
          json: async () => ({}),
        };
      }
      if (url.includes('/rest/images?action=initializeUpload')) {
        imageCount += 1;
        return {
          ok: true,
          json: async () => ({
            value: {
              uploadUrl: `https://upload.test/img${imageCount}`,
              image: `urn:li:image:I${imageCount}`,
            },
          }),
        };
      }
      if (url.includes('/rest/documents?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              uploadUrl: 'https://upload.test/doc',
              document: 'urn:li:document:D1',
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              video: 'urn:li:video:V1',
              uploadToken: 't',
              uploadInstructions: [
                {
                  uploadUrl: 'https://upload.test/p1',
                  firstByte: 0,
                  lastByte: 9,
                },
              ],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.startsWith('https://upload.test/')) {
        return {
          ok: true,
          headers: headersOf({ etag: 'e1' }),
          text: async () => '',
        };
      }
      // The file download from our storage.
      return {
        ok: true,
        headers: headersOf({}),
        arrayBuffer: async () => new ArrayBuffer(10),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const postBodies = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/rest/posts'))
      .map(([, init]) => JSON.parse(init.body as string));
  const postBody = () => {
    const bodies = postBodies();
    expect(bodies).toHaveLength(1);
    return bodies[0];
  };

  const CAPTION = 'Schedura publish test (LinkedIn, 2 photos). #test';
  const LITTLE =
    'Schedura publish test \\(LinkedIn, 2 photos\\). {hashtag|\\#|test}';

  describe('commentary is little text on every format', () => {
    const me = 'urn:li:person:me';
    const formats: [string, () => Promise<unknown>][] = [
      ['text', () => service.createRestTextPost('t', me, CAPTION)],
      [
        'image',
        () =>
          service.createRestImagePost(
            't',
            me,
            CAPTION,
            'https://cdn.test/a.jpg',
          ),
      ],
      [
        'multi-image',
        () =>
          service.createRestMultiImagePost('t', me, CAPTION, [
            { url: 'https://cdn.test/a.jpg' },
            { url: 'https://cdn.test/b.jpg' },
          ]),
      ],
      [
        'video',
        () =>
          service.createRestVideoPost(
            't',
            me,
            CAPTION,
            'https://cdn.test/v.mp4',
          ),
      ],
      [
        'document',
        () =>
          service.createDocumentPost(
            't',
            me,
            CAPTION,
            'https://cdn.test/d.pdf',
            'Deck',
          ),
      ],
      [
        'link card',
        () =>
          service.createArticlePostWithThumbnail('t', me, CAPTION, {
            source: 'https://lumiere.pk',
            title: 'Lumiere',
            thumbnailUrl: 'https://cdn.test/t.jpg',
          }),
      ],
      [
        'poll',
        () => service.createPollPost('t', me, 'Q?', ['A', 'B'], 7, CAPTION),
      ],
    ];

    it.each(formats)('escapes the %s commentary', async (_name, send) => {
      await send();
      expect(postBody().commentary).toBe(LITTLE);
    });

    it('sends text without reserved characters unchanged', async () => {
      await service.createRestTextPost('t', me, 'Plain caption, nothing odd!');
      expect(postBody().commentary).toBe('Plain caption, nothing odd!');
    });
  });

  describe('several photos', () => {
    it('3 images -> one multiImage post with 3 entries, in order, each uploaded', async () => {
      const result = await service.createRestMultiImagePost(
        't',
        'urn:li:person:me',
        'Three',
        [
          { url: 'https://cdn.test/1.jpg', altText: ' First ' },
          { url: 'https://cdn.test/2.jpg' },
          { url: 'https://cdn.test/3.jpg', altText: 'Third' },
        ],
        'LOGGED_IN',
        true,
      );
      expect(result.postId).toBe('urn:li:share:1');
      const body = postBody();
      expect(body.content).toEqual({
        multiImage: {
          images: [
            { id: 'urn:li:image:I1', altText: 'First' },
            { id: 'urn:li:image:I2' },
            { id: 'urn:li:image:I3', altText: 'Third' },
          ],
        },
      });
      expect(body.visibility).toBe('LOGGED_IN');
      expect(body.isReshareDisabledByAuthor).toBe(true);
      // Each file went to its own upload URL, in order.
      const puts = fetchMock.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.startsWith('https://upload.test/img'));
      expect(puts).toEqual([
        'https://upload.test/img1',
        'https://upload.test/img2',
        'https://upload.test/img3',
      ]);
    });

    it.each([[1], [21]])(
      'refuses %i images before uploading anything',
      async (n) => {
        const images = Array.from({ length: n }, (_, i) => ({
          url: `https://cdn.test/${i}.jpg`,
        }));
        await expect(
          service.createRestMultiImagePost(
            't',
            'urn:li:person:me',
            'x',
            images,
          ),
        ).rejects.toThrow(/2 to 20 images/);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('refuses a non-web address before registering any upload', async () => {
      await expect(
        service.createRestMultiImagePost('t', 'urn:li:person:me', 'x', [
          { url: 'https://cdn.test/1.jpg' },
          { url: 'file:///2.jpg' },
        ]),
      ).rejects.toThrow(/web/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('alt text', () => {
    it('reaches a single image post, trimmed', async () => {
      await service.createRestImagePost(
        't',
        'urn:li:person:me',
        'x',
        'https://cdn.test/a.jpg',
        'Latte',
        'PUBLIC',
        false,
        { altText: '  A latte with a fern pattern  ' },
      );
      expect(postBody().content.media).toEqual({
        id: 'urn:li:image:I1',
        title: 'Latte',
        altText: 'A latte with a fern pattern',
      });
    });

    it('reaches a video post', async () => {
      await service.createRestVideoPost(
        't',
        'urn:li:person:me',
        'x',
        'https://cdn.test/v.mp4',
        undefined,
        'PUBLIC',
        false,
        { altText: 'Barista pouring' },
      );
      expect(postBody().content.media).toEqual({
        id: 'urn:li:video:V1',
        altText: 'Barista pouring',
      });
    });

    it('is omitted when blank, and capped at 4,086 characters', async () => {
      await service.createRestImagePost(
        't',
        'urn:li:person:me',
        'x',
        'https://cdn.test/a.jpg',
        undefined,
        'PUBLIC',
        false,
        { altText: '   ' },
      );
      expect(postBody().content.media).toEqual({ id: 'urn:li:image:I1' });

      fetchMock.mockClear();
      await service.createRestMultiImagePost('t', 'urn:li:person:me', 'x', [
        { url: 'https://cdn.test/1.jpg', altText: 'a'.repeat(5000) },
        { url: 'https://cdn.test/2.jpg' },
      ]);
      expect(postBody().content.multiImage.images[0].altText).toHaveLength(
        4086,
      );
    });
  });
});
