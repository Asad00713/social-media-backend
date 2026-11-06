import { BlueskyPublisher } from './bluesky.publisher';
import { BlueskyService } from '../../channels/services/bluesky.service';
import { PublishOptions } from './base.publisher';

/**
 * The link card, which the composer has always been able to edit and
 * the publisher never sent. `createLinkPost` was written in full —
 * external embed, thumbnail blob, facets — and simply never called,
 * so a post with a card went out as bare text with a URL in it.
 *
 * These cover the ROUTING, which is where the decisions are: one
 * embed per post, so a card and media cannot both go; and a thread
 * carries the card on its first post only.
 */
describe('BlueskyPublisher link card', () => {
  let publisher: BlueskyPublisher;
  let service: jest.Mocked<
    Pick<
      BlueskyService,
      'createTextPost' | 'createImagePost' | 'createVideoPost' | 'createLinkPost'
    >
  >;

  const post = (uri: string) => ({ uri, cid: `cid-${uri}` });

  const options = (over: Partial<PublishOptions> = {}): PublishOptions =>
    ({
      content: 'read this',
      mediaItems: [],
      accessToken: 'jwt',
      channelMetadata: { did: 'did:plc:abc', handle: 'me.bsky.social' },
      platformAccountId: 'did:plc:abc',
      metadata: {},
      channelId: 1,
      ...over,
    }) as PublishOptions;

  const CARD = {
    url: 'https://example.com/a',
    title: 'A title',
    description: 'A description',
    thumbUrl: 'https://cdn.example.com/t.jpg',
  };

  beforeEach(() => {
    service = {
      createTextPost: jest.fn().mockResolvedValue(post('at://text')),
      createImagePost: jest.fn().mockResolvedValue(post('at://image')),
      createVideoPost: jest.fn().mockResolvedValue(post('at://video')),
      createLinkPost: jest.fn().mockResolvedValue(post('at://link')),
    };
    publisher = new BlueskyPublisher(service as unknown as BlueskyService);
  });

  it('sends the card instead of bare text', async () => {
    await publisher.publish(options({ metadata: { linkCard: CARD } }));

    expect(service.createLinkPost).toHaveBeenCalledTimes(1);
    expect(service.createTextPost).not.toHaveBeenCalled();
    const args = service.createLinkPost.mock.calls[0];
    expect(args[3]).toBe(CARD.url);
    expect(args[4]).toBe(CARD.title);
    expect(args[5]).toBe(CARD.description);
    expect(args[6]).toBe(CARD.thumbUrl);
  });

  it('keeps the plain text path when there is no card', async () => {
    await publisher.publish(options());
    expect(service.createTextPost).toHaveBeenCalledTimes(1);
    expect(service.createLinkPost).not.toHaveBeenCalled();
  });

  it('prefers MEDIA over a card, because a post carries one embed', async () => {
    // Both would mean choosing which to drop silently. The media is
    // what the user attached; the card is derived from a link in the
    // text, so the media wins.
    await publisher.publish(
      options({
        metadata: { linkCard: CARD },
        mediaItems: [{ type: 'image', url: 'https://x/i.jpg' } as never],
      }),
    );
    expect(service.createImagePost).toHaveBeenCalledTimes(1);
    expect(service.createLinkPost).not.toHaveBeenCalled();
  });

  it.each([
    ['no url key at all', { title: 'orphan' }],
    ['an empty url', { url: '', title: 'orphan' }],
    ['a whitespace url', { url: '   ', title: 'orphan' }],
    ['a non-string url', { url: 42, title: 'orphan' }],
    ['not an object', 'https://example.com'],
  ])('ignores a card with %s', async (_label, linkCard) => {
    // A half-filled card would publish an embed pointing at nothing,
    // which Bluesky renders as a dead grey box. The empty and
    // whitespace cases are the realistic ones: the composer creates
    // the card as soon as a link is typed, so a user who clears the
    // field leaves `url: ''` behind rather than removing the card.
    await publisher.publish(options({ metadata: { linkCard } }));
    expect(service.createTextPost).toHaveBeenCalledTimes(1);
    expect(service.createLinkPost).not.toHaveBeenCalled();
  });

  it('falls back to the URL when the title is empty', async () => {
    // Bluesky renders an empty title as a blank card rather than
    // falling back to the domain itself.
    await publisher.publish(
      options({ metadata: { linkCard: { url: CARD.url, title: '  ' } } }),
    );
    expect(service.createLinkPost.mock.calls[0][4]).toBe(CARD.url);
  });

  describe('in a thread', () => {
    const thread = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];

    it('puts the card on the first post only', async () => {
      // One card per post is all the embed allows, and the composer
      // draws ONE card against the whole draft — repeating it down
      // the thread would publish something nobody composed.
      await publisher.publish(
        options({ metadata: { thread, linkCard: CARD } }),
      );
      expect(service.createLinkPost).toHaveBeenCalledTimes(1);
      expect(service.createTextPost).toHaveBeenCalledTimes(2);
    });

    it('replies the rest to the card post, so the thread holds', async () => {
      // The reason `createLinkPost` needed a `replyTo` at all: without
      // it the card could only ever be a standalone post, and a thread
      // starting with one would come apart into separate posts.
      await publisher.publish(
        options({ metadata: { thread, linkCard: CARD } }),
      );
      const second = service.createTextPost.mock.calls[0];
      const reply = second[3] as { root: { uri: string }; parent: { uri: string } };
      expect(reply.root.uri).toBe('at://link');
      expect(reply.parent.uri).toBe('at://link');
    });

    it('gives the first post no reply ref of its own', async () => {
      await publisher.publish(
        options({ metadata: { thread, linkCard: CARD } }),
      );
      expect(service.createLinkPost.mock.calls[0][7]).toBeUndefined();
    });

    it('skips the card when the first post carries media', async () => {
      await publisher.publish(
        options({
          metadata: {
            thread: [
              { text: 'one', mediaItems: [{ type: 'image', url: 'https://x/i.jpg' }] },
              { text: 'two' },
            ],
            linkCard: CARD,
          },
        }),
      );
      expect(service.createLinkPost).not.toHaveBeenCalled();
      expect(service.createImagePost).toHaveBeenCalledTimes(1);
    });
  });
});
