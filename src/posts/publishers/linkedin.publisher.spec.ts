import { LinkedInPublisher } from './linkedin.publisher';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { PublishOptions } from './base.publisher';

/**
 * Which LinkedIn API each post type takes, and what reaches it.
 *
 * LinkedIn has two publishing APIs here: the legacy `/v2/ugcPosts` (no reshare
 * field, no documents) and the versioned Posts API. A document is the format
 * that exists only on the second, so these tests prove it is routed there and
 * that the composer's settings arrive; the request bodies themselves are
 * pinned in the service specs.
 */
describe('LinkedInPublisher routing', () => {
  let publisher: LinkedInPublisher;
  let service: jest.Mocked<
    Pick<
      LinkedInService,
      | 'createPost'
      | 'createPostWithImage'
      | 'createDocumentPost'
      | 'createPollPost'
      | 'postComment'
    >
  >;

  const DOC = {
    type: 'document',
    url: 'https://cdn.example.com/decks/q3%20report.pdf',
  };

  const options = (
    metadata: Record<string, any>,
    over: Partial<PublishOptions> = {},
  ): PublishOptions =>
    ({
      content: 'Our Q3 numbers',
      mediaItems: [],
      accessToken: 'tok',
      metadata,
      channelMetadata: {},
      platformAccountId: 'me',
      channelId: 1,
      ...over,
    }) as PublishOptions;

  beforeEach(() => {
    service = {
      createPost: jest.fn().mockResolvedValue({ postId: 'urn:li:share:text' }),
      createPostWithImage: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:img' }),
      createDocumentPost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:doc' }),
      createPollPost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:poll' }),
      postComment: jest
        .fn()
        .mockResolvedValue({ commentUrn: 'urn:li:comment:1' }),
    } as any;
    publisher = new LinkedInPublisher(service as unknown as LinkedInService);
  });

  describe('a document post', () => {
    const doc = (metadata: Record<string, any> = {}, item: any = DOC) =>
      options({ postType: 'document', ...metadata }, { mediaItems: [item] });

    it('is published through the Documents + Posts API, not ugcPosts', async () => {
      const result = await publisher.publish(doc());

      expect(service.createDocumentPost).toHaveBeenCalledTimes(1);
      expect(service.createPost).not.toHaveBeenCalled();
      expect(service.createPostWithImage).not.toHaveBeenCalled();
      expect(result.platformPostId).toBe('urn:li:share:doc');
    });

    it('hands the service the token, the member URN, the caption and the file', async () => {
      await publisher.publish(doc());

      const [token, author, commentary, url] =
        service.createDocumentPost.mock.calls[0];
      expect(token).toBe('tok');
      expect(author).toBe('urn:li:person:me');
      expect(commentary).toBe('Our Q3 numbers');
      expect(url).toBe(DOC.url);
    });

    it('uses the file name the composer carried as the title', async () => {
      await publisher.publish(doc({}, { ...DOC, filename: 'Q3 report.pdf' }));
      expect(service.createDocumentPost.mock.calls[0][4]).toBe('Q3 report.pdf');
    });

    it('falls back to the stored file name, decoded, when there is none', async () => {
      await publisher.publish(doc());
      expect(service.createDocumentPost.mock.calls[0][4]).toBe('q3 report.pdf');
    });

    it('falls back to "Document" when the URL has no name', async () => {
      await publisher.publish(
        doc({}, { type: 'document', url: 'https://cdn.example.com/' }),
      );
      expect(service.createDocumentPost.mock.calls[0][4]).toBe('Document');
    });

    it('posts as a page when the channel is one', async () => {
      await publisher.publish({
        ...doc(),
        channelMetadata: { isOrganization: true },
        platformAccountId: '555',
      });
      expect(service.createDocumentPost.mock.calls[0][1]).toBe(
        'urn:li:organization:555',
      );
    });

    describe('reshare control', () => {
      // `reshareDisabled` is the composer's own key; the publisher reads it.
      it('is forwarded when the author turned reposts off', async () => {
        await publisher.publish(doc({ reshareDisabled: true }));
        expect(service.createDocumentPost.mock.calls[0][6]).toBe(true);
      });

      it.each([
        ['not set', {}],
        ['false', { reshareDisabled: false }],
        // A truthy string from a stale client is not a decision.
        ['a string', { reshareDisabled: 'yes' }],
      ])('is left allowed when %s', async (_label, metadata) => {
        await publisher.publish(doc(metadata));
        expect(service.createDocumentPost.mock.calls[0][6]).toBe(false);
      });
    });

    it('passes the chosen audience', async () => {
      await publisher.publish(doc({ visibility: 'connections' }));
      expect(service.createDocumentPost.mock.calls[0][5]).toBe('CONNECTIONS');
    });

    it('still posts the first comment afterwards', async () => {
      const result = await publisher.publish(
        doc({ firstComment: 'Deck above' }),
      );

      expect(service.postComment).toHaveBeenCalledWith(
        'tok',
        'urn:li:person:me',
        'urn:li:share:doc',
        'Deck above',
      );
      expect(result.metadata?.firstCommentUrn).toBe('urn:li:comment:1');
    });

    describe('validation', () => {
      it('refuses a document post with no file, in words', () => {
        expect(() =>
          publisher.validate(options({ postType: 'document' })),
        ).toThrow(/requires a document file/);
      });

      it('refuses a post that attached only a picture', () => {
        expect(() =>
          publisher.validate(
            options(
              { postType: 'document' },
              {
                mediaItems: [{ type: 'image', url: 'https://x/a.png' } as any],
              },
            ),
          ),
        ).toThrow(/requires a document file/);
      });

      it('accepts a document with no caption', () => {
        expect(() =>
          publisher.validate({ ...doc({}), content: '' }),
        ).not.toThrow();
      });

      it('keeps the 3000-character limit', () => {
        expect(() =>
          publisher.validate({ ...doc({}), content: 'x'.repeat(3001) }),
        ).toThrow(/3000/);
      });

      it('lists documents among the supported media types', () => {
        expect(publisher.supportsMediaTypes([DOC as any])).toBe(true);
      });
    });
  });

  describe('a post with no document is untouched', () => {
    it('sends plain text through ugcPosts, as before', async () => {
      await publisher.publish(options({ postType: 'post' }));

      expect(service.createPost).toHaveBeenCalledTimes(1);
      expect(service.createDocumentPost).not.toHaveBeenCalled();
    });

    it('does not read reshareDisabled on a path that cannot carry it', async () => {
      await publisher.publish(
        options({ postType: 'post', reshareDisabled: true }),
      );
      // createPost(token, id, text, visibility): there is no slot for it.
      expect(service.createPost.mock.calls[0]).toHaveLength(4);
    });

    it('still rejects a document attached to a plain post', async () => {
      await expect(
        publisher.publish(
          options({ postType: 'post' }, { mediaItems: [DOC as any] }),
        ),
      ).rejects.toThrow(/Unsupported media type: document/);
    });

    it('still sends a poll with the reshare choice', async () => {
      await publisher.publish(
        options({
          postType: 'poll',
          pollQuestion: 'Which?',
          pollOptions: ['a', 'b'],
          reshareDisabled: true,
        }),
      );
      expect(service.createPollPost.mock.calls[0][7]).toBe(true);
    });
  });
});
