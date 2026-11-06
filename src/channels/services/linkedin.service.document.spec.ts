import { BadRequestException } from '@nestjs/common';
import { LinkedInService } from './linkedin.service';

// These tests stub the network with `global.fetch`. The media download goes
// through the SSRF-guarded fetchPublicMedia (undici + a pinned-DNS agent), so
// route it back to the stub; the guard itself is covered in public-fetch.spec.
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string) => global.fetch(url),
}));

/**
 * PDF posts: Documents API `initializeUpload` -> PUT the file -> Posts API
 * with `content.media`.
 *
 * None of it can be exercised against LinkedIn without publishing, so these
 * tests pin the three REQUESTS themselves — URL, headers and body — taken
 * from LinkedIn's Documents API and Posts API reference pages. A wrong
 * placement here fails quietly (the field is ignored) or rejects the post.
 */
describe('LinkedInService.createDocumentPost', () => {
  const FILE_URL = 'https://cdn.example.com/decks/q3-report.pdf';
  const UPLOAD_URL =
    'https://www.linkedin.com/dms-uploads/D123/ads-uploadedDocument/0';
  const DOC_URN = 'urn:li:document:D5510AQFx87994pYx0Q';
  const MB = 1024 * 1024;

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
    if (url === FILE_URL) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '2048' }),
        arrayBuffer: async () => new ArrayBuffer(2048),
        text: async () => '',
      };
    }
    if (url.includes('/rest/documents?action=initializeUpload')) {
      return json({
        value: {
          uploadUrlExpiresAt: 1650567510704,
          uploadUrl: UPLOAD_URL,
          document: DOC_URN,
        },
      });
    }
    if (url === UPLOAD_URL && init?.method === 'PUT') {
      return json({}, 201);
    }
    if (url === 'https://api.linkedin.com/rest/posts') {
      return json({}, 201, {
        'x-restli-id': 'urn:li:share:6844785523593134080',
      });
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
      visibility?: 'PUBLIC' | 'CONNECTIONS';
      disableReshare?: boolean;
      author?: string;
      commentary?: string;
    } = {},
  ) =>
    service.createDocumentPost(
      'tok',
      over.author ?? 'urn:li:person:me',
      over.commentary ?? 'Our Q3 numbers',
      FILE_URL,
      'q3-report.pdf',
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

  it('registers the upload with the Documents API, owned by the author', async () => {
    await post();

    const { url, init } = callTo((u) => u.includes('/rest/documents'));
    expect(url).toBe(
      'https://api.linkedin.com/rest/documents?action=initializeUpload',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:me' },
    });
  });

  it('sends the token, the protocol header and a version on every versioned call', async () => {
    await post();

    for (const needle of ['/rest/documents', '/rest/posts']) {
      const { init } = callTo((u) => u.includes(needle));
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
      // LinkedIn applies no default version: a call without one is refused.
      expect(headers['Linkedin-Version']).toMatch(/^\d{6}$/);
    }
  });

  it('PUTs the file to the upload URL with the token, byte for byte', async () => {
    await post();

    const { init } = callTo((u, i) => u === UPLOAD_URL && i?.method === 'PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    expect((init.body as ArrayBuffer).byteLength).toBe(2048);
  });

  it('references the uploaded document in content.media, with its title', async () => {
    await post();

    expect(postBody().content).toEqual({
      media: { title: 'q3-report.pdf', id: DOC_URN },
    });
  });

  it('sends the whole post body LinkedIn documents', async () => {
    await post();

    expect(postBody()).toEqual({
      author: 'urn:li:person:me',
      commentary: 'Our Q3 numbers',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { media: { title: 'q3-report.pdf', id: DOC_URN } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('does things in order: register, download, upload, post', async () => {
    await post();

    const sequence = fetchMock.mock.calls.map(([url, init]) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (u.includes('/rest/documents')) return 'register';
      if (u === FILE_URL) return 'download';
      if (u === UPLOAD_URL) return `upload:${method}`;
      if (u.endsWith('/rest/posts')) return 'post';
      return u;
    });
    expect(sequence).toEqual(['register', 'download', 'upload:PUT', 'post']);
  });

  it('returns the URN from the x-restli-id header', async () => {
    await expect(post()).resolves.toEqual({
      postId: 'urn:li:share:6844785523593134080',
    });
  });

  it('falls back to the response body when there is no header', async () => {
    respond = (url, init) =>
      url === 'https://api.linkedin.com/rest/posts'
        ? json({ id: 'urn:li:ugcPost:1' }, 201)
        : defaultRespond(url, init);

    await expect(post()).resolves.toEqual({ postId: 'urn:li:ugcPost:1' });
  });

  describe('reshare control', () => {
    // A document is on the versioned Posts API, which carries the field.
    it('disables resharing when the author asked', async () => {
      await post({ disableReshare: true });
      expect(postBody().isReshareDisabledByAuthor).toBe(true);
    });

    it.each([
      ['explicitly allowed', false],
      ['nothing was chosen', undefined],
    ])('leaves resharing on when %s', async (_label, value) => {
      await post({ disableReshare: value });
      expect(postBody().isReshareDisabledByAuthor).toBe(false);
    });
  });

  describe('visibility', () => {
    it('passes a member audience through', async () => {
      await post({ visibility: 'CONNECTIONS' });
      expect(postBody().visibility).toBe('CONNECTIONS');
    });

    it('forces PUBLIC for a page, which has no member audience', async () => {
      await post({
        author: 'urn:li:organization:42',
        visibility: 'CONNECTIONS',
      });
      expect(postBody().visibility).toBe('PUBLIC');
      expect(postBody().author).toBe('urn:li:organization:42');
    });
  });

  describe('what it will fetch', () => {
    it.each([
      'file:///etc/passwd',
      'ftp://example.com/a.pdf',
      '//cdn.example.com/a.pdf',
      'a.pdf',
    ])('refuses %s, which is not a web address', async (documentUrl) => {
      // The URL is part of the draft; only http(s) is ever downloaded, and
      // nothing is registered with LinkedIn for a file that will not be sent.
      await expect(
        service.createDocumentPost(
          'tok',
          'urn:li:person:me',
          'x',
          documentUrl,
          'a.pdf',
        ),
      ).rejects.toThrow(/web \(http or https\) address/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("LinkedIn's 100 MB limit", () => {
    it('refuses on the declared size, before buffering the file', async () => {
      const arrayBuffer = jest.fn();
      respond = (url, init) =>
        url === FILE_URL
          ? {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-length': String(101 * MB) }),
              arrayBuffer,
              text: async () => '',
            }
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/100 MB/);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(false);
    });

    it('refuses on the real size when no length was declared', async () => {
      respond = (url, init) =>
        url === FILE_URL
          ? {
              ok: true,
              status: 200,
              headers: new Headers(),
              arrayBuffer: async () => ({ byteLength: 100 * MB + 1 }),
              text: async () => '',
            }
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/100 MB/);
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(false);
    });

    it('accepts a file at exactly the limit', async () => {
      respond = (url, init) =>
        url === FILE_URL
          ? {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-length': String(100 * MB) }),
              arrayBuffer: async () => new ArrayBuffer(8),
              text: async () => '',
            }
          : defaultRespond(url, init);

      await expect(post()).resolves.toBeDefined();
    });
  });

  describe('when a step fails', () => {
    it("says what LinkedIn said, and downloads nothing, if it won't take the upload", async () => {
      respond = (url, init) =>
        url.includes('/rest/documents')
          ? json(
              { message: 'Accessing this document resource is forbidden.' },
              403,
            )
          : defaultRespond(url, init);

      const failure = post();
      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(
        /HTTP 403: Accessing this document/,
      );
      expect(fetchMock.mock.calls.some(([u]) => u === FILE_URL)).toBe(false);
    });

    it('does not create a post if the file cannot be fetched', async () => {
      respond = (url, init) =>
        url === FILE_URL
          ? {
              ok: false,
              status: 404,
              headers: new Headers(),
              text: async () => '',
            }
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/HTTP 404/);
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith('/rest/posts')),
      ).toBe(false);
    });

    it('does not create a post if the upload is refused', async () => {
      respond = (url, init) =>
        url === UPLOAD_URL
          ? json({ message: 'nope' }, 403)
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(/upload the document to LinkedIn/);
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).endsWith('/rest/posts')),
      ).toBe(false);
    });

    it('surfaces the reason when the post itself is refused', async () => {
      respond = (url, init) =>
        url === 'https://api.linkedin.com/rest/posts'
          ? json({ message: 'ACCESS_DENIED: w_member_social missing' }, 403)
          : defaultRespond(url, init);

      await expect(post()).rejects.toThrow(
        /document post \(HTTP 403: ACCESS_DENIED: w_member_social missing\)/,
      );
    });
  });
});
