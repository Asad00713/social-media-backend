import { BlueskyService } from './bluesky.service';

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
  let calls: { url: string; body: Record<string, any> }[];

  const ok = (json: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
    });

  beforeEach(() => {
    service = new BlueskyService();
    calls = [];
    global.fetch = jest.fn((url: string, init?: { body?: string }) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(init.body) : {},
      });
      return ok({
        uri: 'at://did:plc:me/app.bsky.feed.post/3kabc',
        cid: 'bafycid',
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const createdRecord = () =>
    calls.find((c) => c.url.endsWith('com.atproto.repo.createRecord'))!.body;

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
});
