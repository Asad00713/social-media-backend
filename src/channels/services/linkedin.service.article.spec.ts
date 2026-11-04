import { BadRequestException } from '@nestjs/common';
import { LinkedInService } from './linkedin.service';

/**
 * A link card with the author's OWN thumbnail.
 *
 * LinkedIn states that the Posts API does no URL scraping: an article carries
 * a `source`, a required `title`, and whatever `description` and `thumbnail`
 * we send. The thumbnail is an Images API asset, so the card costs three
 * requests — register the image, PUT it, post the article — and a wrong
 * placement of any field fails quietly. These tests pin the requests.
 */
describe('LinkedInService.createArticlePostWithThumbnail', () => {
  const IMAGE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/card.png';
  const UPLOAD_URL =
    'https://www.linkedin.com/dms-uploads/C4E10/uploaded-image/0';
  const IMAGE_URN = 'urn:li:image:C4E10AQFoyyAjHPMQuQ';

  let service: LinkedInService;
  let fetchMock: jest.Mock;
  let respond: (url: string, init?: RequestInit) => unknown;

  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const defaultRespond = (url: string, init?: RequestInit) => {
    if (url === IMAGE_URL) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(512),
        text: async () => '',
      };
    }
    if (url.includes('/rest/images?action=initializeUpload')) {
      return json({
        value: {
          uploadUrlExpiresAt: 1650567510704,
          uploadUrl: UPLOAD_URL,
          image: IMAGE_URN,
        },
      });
    }
    if (url === UPLOAD_URL && init?.method === 'PUT') return json({}, 201);
    if (url === 'https://api.linkedin.com/rest/posts') {
      return json({}, 201, { 'x-restli-id': 'urn:li:share:77' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  beforeEach(() => {
    service = new LinkedInService();
    respond = defaultRespond;
    fetchMock = jest.fn(async (url: string, init?: RequestInit) =>
      respond(url, init),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const post = (
    over: {
      article?: Partial<{
        source: string;
        title: string;
        description?: string;
        thumbnailUrl: string;
      }>;
      author?: string;
      visibility?: 'PUBLIC' | 'CONNECTIONS';
      disableReshare?: boolean;
    } = {},
  ) =>
    service.createArticlePostWithThumbnail(
      'tok',
      over.author ?? 'urn:li:person:me',
      'Read this https://lumiere.pk/blog',
      {
        source: 'https://lumiere.pk/blog',
        title: 'lumiere.pk',
        thumbnailUrl: IMAGE_URL,
        ...over.article,
      },
      over.visibility ?? 'PUBLIC',
      over.disableReshare,
    );

  const callTo = (matcher: (url: string, init?: RequestInit) => boolean) => {
    const found = fetchMock.mock.calls.find(([url, init]) =>
      matcher(String(url), init as RequestInit | undefined),
    );
    if (!found) throw new Error('no such call was made');
    return { url: String(found[0]), init: (found[1] ?? {}) as RequestInit };
  };
  const postBody = () =>
    JSON.parse(
      callTo((u) => u === 'https://api.linkedin.com/rest/posts').init
        .body as string,
    );

  it('registers the image with the Images API, owned by the author', async () => {
    await post();

    const { url, init } = callTo((u) => u.includes('/rest/images'));
    expect(url).toBe(
      'https://api.linkedin.com/rest/images?action=initializeUpload',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:me' },
    });
  });

  it('PUTs the picture to the upload URL with the token', async () => {
    await post();

    const { init } = callTo((u, i) => u === UPLOAD_URL && i?.method === 'PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    expect((init.body as ArrayBuffer).byteLength).toBe(512);
  });

  it('puts the image URN in content.article.thumbnail, beside source and title', async () => {
    await post({ article: { description: 'The autumn menu' } });

    expect(postBody().content).toEqual({
      article: {
        source: 'https://lumiere.pk/blog',
        thumbnail: IMAGE_URN,
        title: 'lumiere.pk',
        description: 'The autumn menu',
      },
    });
  });

  it('sends the whole post body LinkedIn documents', async () => {
    await post();

    expect(postBody()).toEqual({
      author: 'urn:li:person:me',
      commentary: 'Read this https://lumiere.pk/blog',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: 'https://lumiere.pk/blog',
          thumbnail: IMAGE_URN,
          title: 'lumiere.pk',
        },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])(
    'leaves description out of the article when it is %s',
    async (_l, description) => {
      await post({ article: { description } });
      expect('description' in postBody().content.article).toBe(false);
    },
  );

  it('does things in order: register, download, upload, post', async () => {
    await post();

    const sequence = fetchMock.mock.calls.map(([url, init]) => {
      const u = String(url);
      if (u.includes('/rest/images')) return 'register';
      if (u === IMAGE_URL) return 'download';
      if (u === UPLOAD_URL) return `upload:${(init as RequestInit).method}`;
      if (u.endsWith('/rest/posts')) return 'post';
      return u;
    });
    expect(sequence).toEqual(['register', 'download', 'upload:PUT', 'post']);
  });

  it('sends the versioned headers on the registration and the post', async () => {
    await post();

    for (const needle of ['/rest/images', '/rest/posts']) {
      const headers = callTo((u) => u.includes(needle)).init.headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
      expect(headers['Linkedin-Version']).toMatch(/^\d{6}$/);
    }
  });

  it('returns the URN from the x-restli-id header', async () => {
    await expect(post()).resolves.toEqual({ postId: 'urn:li:share:77' });
  });

  describe('reshare control', () => {
    it('disables resharing when the author asked', async () => {
      await post({ disableReshare: true });
      expect(postBody().isReshareDisabledByAuthor).toBe(true);
    });

    it('leaves it on otherwise', async () => {
      await post();
      expect(postBody().isReshareDisabledByAuthor).toBe(false);
    });
  });

  it('posts as a page when the author is one, owning the image too', async () => {
    await post({ author: 'urn:li:organization:42', visibility: 'CONNECTIONS' });

    expect(
      JSON.parse(callTo((u) => u.includes('/rest/images')).init.body as string),
    ).toEqual({ initializeUploadRequest: { owner: 'urn:li:organization:42' } });
    expect(postBody().author).toBe('urn:li:organization:42');
    expect(postBody().visibility).toBe('PUBLIC');
  });

  describe('when a step fails', () => {
    it('creates no post if the picture cannot be fetched', async () => {
      respond = (url, init) =>
        url === IMAGE_URL
          ? {
              ok: false,
              status: 404,
              headers: new Headers(),
              text: async () => '',
            }
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/image .*HTTP 404/);
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith('/rest/posts')),
      ).toBe(false);
    });

    it('creates no post if LinkedIn refuses the upload', async () => {
      respond = (url, init) =>
        url === UPLOAD_URL
          ? json({ message: 'unsupported image' }, 422)
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/HTTP 422: unsupported image/);
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith('/rest/posts')),
      ).toBe(false);
    });

    it('surfaces the reason when the article itself is refused', async () => {
      respond = (url, init) =>
        url === 'https://api.linkedin.com/rest/posts'
          ? json({ message: 'title is required' }, 400)
          : defaultRespond(url, init);

      const failure = post();
      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(
        /link post \(HTTP 400: title is required\)/,
      );
    });
  });

  describe('what it will fetch', () => {
    it.each([
      'file:///etc/passwd',
      'ftp://example.com/a.png',
      '//cdn.example.com/a.png',
      'a.png',
    ])('refuses %s, which is not a web address', async (thumbnailUrl) => {
      // The URL is part of the draft; only http(s) is ever downloaded.
      await expect(post({ article: { thumbnailUrl } })).rejects.toThrow(
        /web \(http or https\) address/,
      );
      expect(fetchMock.mock.calls.some(([u]) => u === thumbnailUrl)).toBe(
        false,
      );
    });
  });
});
