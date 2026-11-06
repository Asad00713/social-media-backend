import { BlueskyService, postgateEmbeddingRules } from './bluesky.service';

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
 * The exact record bodies the service writes to a Bluesky repo.
 *
 * The publisher specs mock this service, so they prove a value REACHES it;
 * only a spec at this level can prove WHERE it lands in the record — and a
 * field in the wrong place of an atproto record is accepted by the PDS and
 * ignored, so it fails quietly.
 */
describe('BlueskyService record bodies', () => {
  let service: BlueskyService;
  const realFetch = global.fetch;
  let calls: { url: string; init: Record<string, any>; body: any }[];

  const ok = (json: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
    });

  const POST_URI = 'at://did:plc:me/app.bsky.feed.post/3kabc';

  /** One fake network: record writes, blob uploads, and plain media GETs. */
  function installFetch(over?: (url: string) => Promise<unknown> | undefined) {
    global.fetch = jest.fn((url: string, init?: Record<string, any>) => {
      const body =
        init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : init?.body;
      calls.push({ url: String(url), init: init ?? {}, body });
      const custom = over?.(String(url));
      if (custom) return custom;
      if (String(url).endsWith('com.atproto.repo.uploadBlob')) {
        return ok({ blob: { $type: 'blob', ref: { $link: 'bafyblob' } } });
      }
      if (String(url).endsWith('com.atproto.repo.createRecord')) {
        return ok({ uri: POST_URI, cid: 'bafycid' });
      }
      if (String(url).endsWith('com.atproto.repo.putRecord')) {
        return ok({ uri: 'at://x', cid: 'y' });
      }
      // A media download.
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        headers: { get: () => 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    service = new BlueskyService();
    calls = [];
    installFetch();
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const createdRecord = () =>
    calls.find((c) => c.url.endsWith('com.atproto.repo.createRecord'))!.body;
  const putRecord = () =>
    calls.find((c) => c.url.endsWith('com.atproto.repo.putRecord'))!;

  describe('createLinkPost', () => {
    const ROOT = { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'c1' };
    const PARENT = {
      uri: 'at://did:plc:me/app.bsky.feed.post/parent',
      cid: 'c2',
    };

    // Two PRs each added a trailing parameter here (the reply ref, and the
    // post settings). A call that passes one in the other's slot would
    // compile-fail in the app but pass a mocked publisher spec, so the real
    // method is driven with both.
    it('carries the reply ref AND the language on the record', async () => {
      await service.createLinkPost(
        'jwt',
        'did:plc:me',
        'read this',
        'https://example.com/a',
        'A title',
        'A description',
        undefined,
        { root: ROOT, parent: PARENT },
        { langs: ['ur'] },
      );

      const { record, collection, repo } = createdRecord();
      expect(repo).toBe('did:plc:me');
      expect(collection).toBe('app.bsky.feed.post');
      expect(record.reply).toEqual({ root: ROOT, parent: PARENT });
      expect(record.langs).toEqual(['ur']);
      expect(record.embed).toEqual({
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com/a',
          title: 'A title',
          description: 'A description',
        },
      });
    });
  });

  describe('createLinkPost thumbnail', () => {
    const THUMB_URL = 'https://cdn.example.com/card.jpg';
    const BLOB = { $type: 'blob', ref: { $link: 'bafyblob' } };

    /** A fake network that serves a thumbnail of the given size. */
    function serveThumb(bytes: number, contentType = 'image/jpeg') {
      installFetch((url) =>
        url === THUMB_URL
          ? Promise.resolve({
              ok: true,
              status: 200,
              arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
              headers: { get: () => contentType },
            })
          : undefined,
      );
    }

    const create = () =>
      service.createLinkPost(
        'jwt',
        'did:plc:me',
        'read this',
        'https://example.com/a',
        'A title',
        'A description',
        THUMB_URL,
      );

    const uploads = () =>
      calls.filter((c) => c.url.endsWith('com.atproto.repo.uploadBlob'));

    it('uploads the image and puts the blob on the card', async () => {
      serveThumb(500_000, 'image/png');
      await create();

      expect(uploads()).toHaveLength(1);
      expect(uploads()[0].init.headers['Content-Type']).toBe('image/png');
      expect(uploads()[0].init.headers.Authorization).toBe('Bearer jwt');
      expect(createdRecord().record.embed.external.thumb).toEqual(BLOB);
    });

    // The lexicon's `maxSize: 1000000` is inclusive.
    it('still uploads an image of exactly 1,000,000 bytes', async () => {
      serveThumb(1_000_000);
      await create();

      expect(uploads()).toHaveLength(1);
      expect(createdRecord().record.embed.external.thumb).toEqual(BLOB);
    });

    // Past it the PDS refuses the whole record, so the post would fail for
    // the sake of a picture: the card goes out without one instead.
    it('posts the card without an image over 1,000,000 bytes', async () => {
      serveThumb(1_000_001);
      await create();

      expect(uploads()).toHaveLength(0);
      expect(createdRecord().record.embed.external).not.toHaveProperty('thumb');
      expect(createdRecord().record.embed.external.title).toBe('A title');
    });

    it('posts the card without an image it could not download', async () => {
      installFetch((url) =>
        url === THUMB_URL
          ? Promise.resolve({ ok: false, status: 404 })
          : undefined,
      );
      await create();

      expect(uploads()).toHaveLength(0);
      expect(createdRecord().record.embed.external).not.toHaveProperty('thumb');
    });
  });

  describe('setPostQuoteControl (the postgate)', () => {
    const RULES = [{ $type: 'app.bsky.feed.postgate#disableRule' }];

    it('writes a postgate under the SAME rkey as the post', async () => {
      await service.setPostQuoteControl('jwt', 'did:plc:me', POST_URI, RULES);

      const put = putRecord();
      expect(put.url).toBe(
        'https://bsky.social/xrpc/com.atproto.repo.putRecord',
      );
      expect(put.init.method).toBe('POST');
      expect(put.init.headers.Authorization).toBe('Bearer jwt');
      expect(put.body).toEqual({
        repo: 'did:plc:me',
        collection: 'app.bsky.feed.postgate',
        rkey: '3kabc',
        record: {
          $type: 'app.bsky.feed.postgate',
          post: POST_URI,
          embeddingRules: [{ $type: 'app.bsky.feed.postgate#disableRule' }],
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      });
    });

    it('refuses a URI that is not a post of this network', async () => {
      await expect(
        service.setPostQuoteControl('jwt', 'did:plc:me', 'at://x/y/z', RULES),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it('reports a rejected write instead of swallowing it', async () => {
      installFetch((url) =>
        url.endsWith('putRecord')
          ? Promise.resolve({
              ok: false,
              status: 400,
              text: () => Promise.resolve('InvalidRecord'),
            })
          : undefined,
      );
      await expect(
        service.setPostQuoteControl('jwt', 'did:plc:me', POST_URI, RULES),
      ).rejects.toThrow(/postgate write failed: 400 InvalidRecord/);
    });
  });

  describe('postgateEmbeddingRules', () => {
    // The opposite default to the threadgate: an empty `embeddingRules`
    // means anyone may quote, so allowing quotes writes NO record, and
    // only an explicit `false` writes one.
    it.each([
      ['quotes are allowed', { allowQuotes: true }],
      ['nothing was chosen', {}],
      ['there are no settings', undefined],
    ])('writes no record when %s', (_label, settings) => {
      expect(postgateEmbeddingRules(settings)).toBeNull();
    });

    it('writes the one disable rule when quotes are off', () => {
      expect(postgateEmbeddingRules({ allowQuotes: false })).toEqual([
        { $type: 'app.bsky.feed.postgate#disableRule' },
      ]);
    });
  });

  describe('self-labels (the content warning)', () => {
    const LABELS = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: 'graphic-media' }],
    };
    const settings = { labels: ['graphic-media' as const] };

    it('puts them on a text post, as the union the lexicon asks for', async () => {
      await service.createTextPost(
        'jwt',
        'did:plc:me',
        'hello',
        undefined,
        settings,
      );
      expect(createdRecord().record.labels).toEqual(LABELS);
    });

    it('puts them on an image post', async () => {
      await service.createImagePost(
        'jwt',
        'did:plc:me',
        'hello',
        ['https://cdn.example.com/a.jpg'],
        ['alt'],
        undefined,
        settings,
      );
      expect(createdRecord().record.labels).toEqual(LABELS);
    });

    it('puts them on a video post', async () => {
      jest
        .spyOn(service as any, 'resolvePdsHost')
        .mockResolvedValue('pds.example');
      jest
        .spyOn(service as any, 'uploadVideoViaService')
        .mockResolvedValue({ $type: 'blob', ref: { $link: 'bafyvid' } });
      await service.createVideoPost(
        'jwt',
        'did:plc:me',
        'hello',
        'https://cdn.example.com/v.mp4',
        undefined,
        undefined,
        settings,
      );
      expect(createdRecord().record.labels).toEqual(LABELS);
    });

    it('puts them on a link-card post', async () => {
      await service.createLinkPost(
        'jwt',
        'did:plc:me',
        'hello',
        'https://example.com/a',
        'A title',
        undefined,
        undefined,
        undefined,
        settings,
      );
      expect(createdRecord().record.labels).toEqual(LABELS);
    });

    it('sends none when none were chosen', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hello', undefined, {
        langs: ['en'],
      });
      expect(createdRecord().record).not.toHaveProperty('labels');
    });

    // `!hide` / `!warn` are moderation directives, not an author's warning.
    it('refuses values outside the four content labels', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hello', undefined, {
        labels: ['!hide', 'bot', 'porn'] as never,
      });
      expect(createdRecord().record.labels.values).toEqual([{ val: 'porn' }]);
    });

    it('lists a label once, however often it was given', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hello', undefined, {
        labels: ['porn', 'porn', 'nudity', 'porn'],
      });
      expect(createdRecord().record.labels.values).toEqual([
        { val: 'porn' },
        { val: 'nudity' },
      ]);
    });

    it('sends nothing at all when every value was refused', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hello', undefined, {
        labels: ['!hide'] as never,
      });
      expect(createdRecord().record).not.toHaveProperty('labels');
    });
  });
});
