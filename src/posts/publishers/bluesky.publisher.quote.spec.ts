import { Test } from '@nestjs/testing';
import { BlueskyPublisher } from './bluesky.publisher';
import { BlueskyService } from '../../channels/services/bluesky.service';

/**
 * The quote link and hidden tags reaching the service.
 *
 * `quotePostUrl` and `tags` are the publisher's own keys — the composer's
 * `platformSpecific` arrives here verbatim, so a name of the composer's own
 * would be ignored.
 */
describe('BlueskyPublisher — quote a post, hidden tags', () => {
  let publisher: BlueskyPublisher;
  let service: Record<string, jest.Mock>;

  const QUOTE = { uri: 'at://did:plc:them/app.bsky.feed.post/3kq', cid: 'q' };
  const LINK = 'https://bsky.app/profile/them.bsky.social/post/3kq';
  let n = 0;

  beforeEach(async () => {
    n = 0;
    const post = () =>
      Promise.resolve({
        uri: `at://did:plc:me/app.bsky.feed.post/p${++n}`,
        cid: `c${n}`,
      });
    service = {
      createTextPost: jest.fn(post),
      createImagePost: jest.fn(post),
      createVideoPost: jest.fn(post),
      createLinkPost: jest.fn(post),
      setPostReplyControl: jest.fn(),
      setPostQuoteControl: jest.fn(),
      resolveQuotedPost: jest.fn().mockResolvedValue(QUOTE),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BlueskyPublisher,
        { provide: BlueskyService, useValue: service },
      ],
    }).compile();
    publisher = moduleRef.get(BlueskyPublisher);
  });

  const options = (
    metadata: Record<string, any>,
    extra: Record<string, any> = {},
  ) => ({
    content: 'This, exactly',
    mediaItems: [],
    accessToken: 'jwt',
    platformAccountId: 'did:plc:me',
    channelMetadata: { did: 'did:plc:me', handle: 'me.bsky.social' },
    channelId: 1,
    metadata,
    ...extra,
  });

  describe('quote a post', () => {
    it('resolves the link and hands the ref to the text post', async () => {
      await publisher.publish(options({ quotePostUrl: LINK }));

      expect(service.resolveQuotedPost).toHaveBeenCalledWith('jwt', LINK);
      expect(service.createTextPost.mock.calls[0][4].quote).toEqual(QUOTE);
    });

    it('hands it to an image post too (recordWithMedia)', async () => {
      await publisher.publish(
        options(
          { quotePostUrl: LINK },
          { mediaItems: [{ type: 'image', url: 'https://cdn/a.jpg' }] },
        ),
      );

      expect(service.createImagePost.mock.calls[0][6].quote).toEqual(QUOTE);
    });

    it('hands it to a link-card post too', async () => {
      await publisher.publish(
        options({
          quotePostUrl: LINK,
          linkCard: { url: 'https://example.com', title: 'Ex' },
        }),
      );

      expect(service.createLinkPost.mock.calls[0][8].quote).toEqual(QUOTE);
    });

    it('resolves BEFORE posting, so a dead link posts nothing', async () => {
      service.resolveQuotedPost.mockRejectedValue(new Error('gone'));

      await expect(
        publisher.publish(options({ quotePostUrl: LINK })),
      ).rejects.toThrow('gone');
      expect(service.createTextPost).not.toHaveBeenCalled();
    });

    it('refuses a link that is not a Bluesky post in validate()', () => {
      expect(() =>
        publisher.validate(
          options({ quotePostUrl: 'https://x.com/a/status/1' }),
        ),
      ).toThrow('is not a link to a Bluesky post');
    });

    it('lets a bare quote with no text through', () => {
      expect(() =>
        publisher.validate(options({ quotePostUrl: LINK }, { content: '' })),
      ).not.toThrow();
    });

    it('still refuses an empty post with no quote', () => {
      expect(() => publisher.validate(options({}, { content: '' }))).toThrow(
        'must have text',
      );
    });

    it('does nothing for a blank link', async () => {
      await publisher.publish(options({ quotePostUrl: '  ' }));

      expect(service.resolveQuotedPost).not.toHaveBeenCalled();
      expect(service.createTextPost.mock.calls[0][4].quote).toBeUndefined();
    });

    it('quotes nothing in a thread', async () => {
      await publisher.publish(
        options({
          quotePostUrl: LINK,
          thread: [{ text: 'one' }, { text: 'two' }],
        }),
      );

      expect(service.resolveQuotedPost).not.toHaveBeenCalled();
      for (const call of service.createTextPost.mock.calls) {
        expect(call[4].quote).toBeUndefined();
      }
    });
  });

  describe('hidden tags', () => {
    it('reach the service, normalised', async () => {
      await publisher.publish(options({ tags: ['#coffee', ' latte'] }));

      expect(service.createTextPost.mock.calls[0][4].tags).toEqual([
        'coffee',
        'latte',
      ]);
    });

    it('are refused over 8, before anything is posted', async () => {
      const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);

      await expect(publisher.publish(options({ tags: nine }))).rejects.toThrow(
        'at most 8 hidden tags',
      );
      expect(service.createTextPost).not.toHaveBeenCalled();
    });

    it('accept exactly 8', () => {
      const eight = Array.from({ length: 8 }, (_, i) => `t${i}`);
      expect(() => publisher.validate(options({ tags: eight }))).not.toThrow();
    });

    it('refuse a tag over 64 characters', () => {
      expect(() =>
        publisher.validate(options({ tags: ['x'.repeat(65)] })),
      ).toThrow('over 64 characters');
    });

    it('are checked on a thread too', () => {
      expect(() =>
        publisher.validate(
          options({
            tags: ['x'.repeat(65)],
            thread: [{ text: 'one' }, { text: 'two' }],
          }),
        ),
      ).toThrow('over 64 characters');
    });

    it('go on the first post of a thread only', async () => {
      await publisher.publish(
        options({
          tags: ['coffee'],
          thread: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
        }),
      );

      const calls = service.createTextPost.mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][4].tags).toEqual(['coffee']);
      expect(calls[1][4].tags).toBeUndefined();
      expect(calls[2][4].tags).toBeUndefined();
    });
  });
});
