import {
  BlueskyService,
  embedWithQuote,
  graphemeCount,
  parseBlueskyPostLink,
  postTags,
} from './bluesky.service';

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
 * Quote posts and hidden tags, at the level of the record the PDS gets.
 *
 * A field in the wrong place of an atproto record is often accepted and
 * ignored, so these pin the exact `embed` / `tags` bodies — the publisher
 * spec can only prove a value reaches this service.
 */
describe('BlueskyService — quote posts and hidden tags', () => {
  let service: BlueskyService;
  const realFetch = global.fetch;
  let calls: { url: string; body: any }[];

  const QUOTE = {
    uri: 'at://did:plc:them/app.bsky.feed.post/3kq',
    cid: 'bafyquote',
  };

  const ok = (json: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
    });

  function installFetch(over?: (url: string) => Promise<unknown> | undefined) {
    global.fetch = jest.fn((url: string, init?: Record<string, any>) => {
      const body =
        init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : undefined;
      calls.push({ url: String(url), body });
      const custom = over?.(String(url));
      if (custom) return custom;
      if (String(url).endsWith('com.atproto.repo.uploadBlob')) {
        return ok({ blob: { $type: 'blob', ref: { $link: 'bafyblob' } } });
      }
      if (String(url).endsWith('com.atproto.repo.createRecord')) {
        return ok({ uri: 'at://did:plc:me/app.bsky.feed.post/new', cid: 'c' });
      }
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
  });

  const created = () =>
    calls.find((c) => c.url.endsWith('com.atproto.repo.createRecord'))!.body
      .record;

  describe('the quote embed', () => {
    it('is app.bsky.embed.record on a text post', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'look', undefined, {
        quote: QUOTE,
      });

      expect(created().embed).toEqual({
        $type: 'app.bsky.embed.record',
        record: { uri: QUOTE.uri, cid: QUOTE.cid },
      });
    });

    it('wraps images in recordWithMedia', async () => {
      await service.createImagePost(
        'jwt',
        'did:plc:me',
        'look',
        ['https://cdn/a.jpg'],
        ['alt'],
        undefined,
        { quote: QUOTE },
      );

      const embed = created().embed;
      expect(embed.$type).toBe('app.bsky.embed.recordWithMedia');
      expect(embed.record).toEqual({
        record: { uri: QUOTE.uri, cid: QUOTE.cid },
      });
      expect(embed.media.$type).toBe('app.bsky.embed.images');
      expect(embed.media.images).toHaveLength(1);
    });

    it('wraps a link card in recordWithMedia', async () => {
      await service.createLinkPost(
        'jwt',
        'did:plc:me',
        'look',
        'https://example.com',
        'Example',
        'desc',
        undefined,
        undefined,
        { quote: QUOTE },
      );

      const embed = created().embed;
      expect(embed.$type).toBe('app.bsky.embed.recordWithMedia');
      expect(embed.record.record).toEqual(QUOTE);
      expect(embed.media).toEqual({
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'desc',
        },
      });
    });

    it('leaves the embed alone without a quote', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'look', undefined, {});

      expect(created().embed).toBeUndefined();
    });

    it('is a pure function of media and quote', () => {
      const media = { $type: 'app.bsky.embed.video', video: {} };
      expect(embedWithQuote(media, undefined)).toBe(media);
      expect(embedWithQuote(undefined, undefined)).toBeUndefined();
      expect(embedWithQuote(media, QUOTE)).toEqual({
        $type: 'app.bsky.embed.recordWithMedia',
        record: { record: QUOTE },
        media,
      });
    });
  });

  describe('hidden tags', () => {
    it('go on the record as `tags`, without the #', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hi', undefined, {
        tags: ['#coffee', ' latte '],
      });

      expect(created().tags).toEqual(['coffee', 'latte']);
    });

    it('are absent when none were given', async () => {
      await service.createTextPost('jwt', 'did:plc:me', 'hi', undefined, {});

      expect(created()).not.toHaveProperty('tags');
    });

    it('stop at the lexicon cap of 8', () => {
      const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
      expect(postTags({ tags: ten })).toHaveLength(8);
    });

    it('drop a tag over 64 graphemes and keep one of exactly 64', () => {
      expect(postTags({ tags: ['a'.repeat(64), 'b'.repeat(65)] })).toEqual([
        'a'.repeat(64),
      ]);
    });

    it('count an emoji with a skin tone as one grapheme', () => {
      expect(graphemeCount('👍🏽')).toBe(1);
    });

    it('list a tag once', () => {
      expect(postTags({ tags: ['a', '#a', 'b'] })).toEqual(['a', 'b']);
    });
  });

  describe('parseBlueskyPostLink', () => {
    it.each([
      [
        'https://bsky.app/profile/alice.bsky.social/post/3kabc',
        { actor: 'alice.bsky.social', rkey: '3kabc' },
      ],
      [
        'https://bsky.app/profile/did:plc:abc/post/3kabc?ref=x',
        { actor: 'did:plc:abc', rkey: '3kabc' },
      ],
      [
        'at://did:plc:abc/app.bsky.feed.post/3kabc',
        { actor: 'did:plc:abc', rkey: '3kabc' },
      ],
    ])('reads %s', (link, expected) => {
      expect(parseBlueskyPostLink(link)).toEqual(expected);
    });

    it.each([
      'https://bsky.app/profile/alice.bsky.social',
      'https://example.com/profile/alice/post/3k',
      'at://did:plc:abc/app.bsky.feed.like/3k',
      'https://bsky.app/profile/%E0%A4%A/post/3k',
    ])('refuses %s', (link) => {
      expect(parseBlueskyPostLink(link)).toBeNull();
    });
  });

  describe('resolveQuotedPost', () => {
    const postsWith = (post: unknown) => ok({ posts: post ? [post] : [] });

    it('resolves a handle to a DID, then reads the CID', async () => {
      installFetch((url) => {
        if (url.includes('resolveHandle')) return ok({ did: 'did:plc:them' });
        if (url.includes('getPosts')) return postsWith(QUOTE);
        return undefined;
      });

      const ref = await service.resolveQuotedPost(
        'jwt',
        'https://bsky.app/profile/them.bsky.social/post/3kq',
      );

      expect(ref).toEqual(QUOTE);
      expect(calls[0].url).toContain(
        'com.atproto.identity.resolveHandle?handle=them.bsky.social',
      );
      // The record URI must use the DID, never the handle.
      expect(decodeURIComponent(calls[1].url)).toContain(
        'uris=at://did:plc:them/app.bsky.feed.post/3kq',
      );
    });

    it('skips the handle lookup for a DID link', async () => {
      installFetch((url) =>
        url.includes('getPosts') ? postsWith(QUOTE) : undefined,
      );

      await service.resolveQuotedPost(
        'jwt',
        'https://bsky.app/profile/did:plc:them/post/3kq',
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('app.bsky.feed.getPosts');
    });

    it('refuses an unknown handle', async () => {
      installFetch((url) =>
        url.includes('resolveHandle')
          ? Promise.resolve({ ok: false, status: 400, json: () => ({}) })
          : undefined,
      );

      await expect(
        service.resolveQuotedPost(
          'jwt',
          'https://bsky.app/profile/nobody.example/post/3kq',
        ),
      ).rejects.toThrow('no Bluesky account @nobody.example');
    });

    it('refuses a post that is gone', async () => {
      installFetch((url) =>
        url.includes('getPosts') ? postsWith(undefined) : undefined,
      );

      await expect(
        service.resolveQuotedPost(
          'jwt',
          'at://did:plc:them/app.bsky.feed.post/3kq',
        ),
      ).rejects.toThrow('could not be found');
    });

    it('refuses a post that came back without a CID', async () => {
      installFetch((url) =>
        url.includes('getPosts') ? postsWith({ uri: QUOTE.uri }) : undefined,
      );

      await expect(
        service.resolveQuotedPost(
          'jwt',
          'at://did:plc:them/app.bsky.feed.post/3kq',
        ),
      ).rejects.toThrow('could not be found');
    });

    it('refuses a post whose author turned quoting off', async () => {
      installFetch((url) =>
        url.includes('getPosts')
          ? postsWith({ ...QUOTE, viewer: { embeddingDisabled: true } })
          : undefined,
      );

      await expect(
        service.resolveQuotedPost(
          'jwt',
          'at://did:plc:them/app.bsky.feed.post/3kq',
        ),
      ).rejects.toThrow('turned quoting off');
    });

    it('refuses something that is not a post link without a request', async () => {
      await expect(
        service.resolveQuotedPost('jwt', 'https://example.com/x'),
      ).rejects.toThrow('is not a link to a Bluesky post');
      expect(calls).toHaveLength(0);
    });
  });
});
