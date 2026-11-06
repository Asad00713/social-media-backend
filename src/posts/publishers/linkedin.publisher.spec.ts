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
      | 'createPostWithLink'
      | 'createArticlePostWithThumbnail'
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
      createPostWithLink: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:link' }),
      createArticlePostWithThumbnail: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:card' }),
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

  describe('a link whose card carries the author’s own image', () => {
    const THUMB = 'https://res.cloudinary.com/demo/image/upload/v1/card.png';
    const card = (
      metadata: Record<string, any> = {},
      over: Partial<PublishOptions> = {},
    ) =>
      options(
        { postType: 'post', linkThumbnailUrl: THUMB, ...metadata },
        { content: 'Read this https://www.lumiere.pk/blog/autumn.', ...over },
      );

    it('is published as an article on the versioned Posts API', async () => {
      const result = await publisher.publish(card());

      expect(service.createArticlePostWithThumbnail).toHaveBeenCalledTimes(1);
      expect(service.createPost).not.toHaveBeenCalled();
      expect(service.createPostWithLink).not.toHaveBeenCalled();
      expect(result.platformPostId).toBe('urn:li:share:card');
    });

    it('takes its source from the first link in the caption, without the full stop', async () => {
      await publisher.publish(card());

      const [token, author, commentary, article] =
        service.createArticlePostWithThumbnail.mock.calls[0];
      expect(token).toBe('tok');
      expect(author).toBe('urn:li:person:me');
      expect(commentary).toBe('Read this https://www.lumiere.pk/blog/autumn.');
      expect(article.source).toBe('https://www.lumiere.pk/blog/autumn');
      expect(article.thumbnailUrl).toBe(THUMB);
    });

    it('uses the first of several links, as the card the composer draws does', async () => {
      await publisher.publish(
        card(
          {},
          { content: 'A https://one.example/a then https://two.example/b' },
        ),
      );
      expect(
        service.createArticlePostWithThumbnail.mock.calls[0][3].source,
      ).toBe('https://one.example/a');
    });

    it('prefers an explicit linkUrl to one found in the caption', async () => {
      await publisher.publish(card({ linkUrl: 'https://chosen.example/x' }));
      expect(
        service.createArticlePostWithThumbnail.mock.calls[0][3].source,
      ).toBe('https://chosen.example/x');
    });

    describe('title and description', () => {
      // The Posts API reads nothing from the page, so the title is required
      // and is whatever is sent: the author's, else the site's name.
      it("defaults the title to the site's name, without www", async () => {
        await publisher.publish(card());
        expect(
          service.createArticlePostWithThumbnail.mock.calls[0][3].title,
        ).toBe('lumiere.pk');
      });

      it("uses the author's title and description when they wrote them", async () => {
        await publisher.publish(
          card({ linkTitle: ' Autumn menu ', linkDescription: ' Back soon ' }),
        );
        const article = service.createArticlePostWithThumbnail.mock.calls[0][3];
        expect(article.title).toBe('Autumn menu');
        expect(article.description).toBe('Back soon');
      });

      it('sends no description when there is none', async () => {
        await publisher.publish(card());
        expect(
          service.createArticlePostWithThumbnail.mock.calls[0][3].description,
        ).toBeUndefined();
      });

      it("keeps to LinkedIn's lengths: under 400 for a title, under 4,086 for a description", async () => {
        await publisher.publish(
          card({
            linkTitle: 'T'.repeat(900),
            linkDescription: 'D'.repeat(9000),
          }),
        );
        const article = service.createArticlePostWithThumbnail.mock.calls[0][3];
        expect(article.title).toHaveLength(399);
        expect(article.description).toHaveLength(4085);
      });
    });

    it('hands over the audience and posts as a page when the channel is one', async () => {
      await publisher.publish({
        ...card({ visibility: 'connections' }),
        channelMetadata: { isOrganization: true },
        platformAccountId: '555',
      });
      const call = service.createArticlePostWithThumbnail.mock.calls[0];
      expect(call[1]).toBe('urn:li:organization:555');
      expect(call[4]).toBe('CONNECTIONS');
    });

    describe('reshare control', () => {
      it('is forwarded when the author turned reposts off', async () => {
        await publisher.publish(card({ reshareDisabled: true }));
        expect(service.createArticlePostWithThumbnail.mock.calls[0][5]).toBe(
          true,
        );
      });

      it.each([
        ['not set', {}],
        ['a string', { reshareDisabled: 'yes' }],
      ])('is left allowed when %s', async (_label, metadata) => {
        await publisher.publish(card(metadata));
        expect(service.createArticlePostWithThumbnail.mock.calls[0][5]).toBe(
          false,
        );
      });
    });

    describe('is a card only while there is something to be a card', () => {
      it('is plain text when the caption has no link', async () => {
        await publisher.publish(card({}, { content: 'No link here' }));

        expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
        expect(service.createPost).toHaveBeenCalledTimes(1);
      });

      it('is plain text when the image is blank', async () => {
        await publisher.publish(card({ linkThumbnailUrl: '   ' }));

        expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
        expect(service.createPost).toHaveBeenCalledTimes(1);
      });

      it('gives way to attached media, which carries the link as text', async () => {
        await publisher.publish(
          card(
            {},
            { mediaItems: [{ type: 'image', url: 'https://x/a.png' } as any] },
          ),
        );

        expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
        expect(service.createPostWithImage).toHaveBeenCalledTimes(1);
      });

      it('does not apply to a document, which has its own route', async () => {
        await publisher.publish(
          card({ postType: 'document' }, { mediaItems: [DOC as any] }),
        );

        expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
        expect(service.createDocumentPost).toHaveBeenCalledTimes(1);
      });
    });

    it('still posts the first comment afterwards', async () => {
      const result = await publisher.publish(
        card({ firstComment: 'Thoughts?' }),
      );

      expect(service.postComment).toHaveBeenCalledWith(
        'tok',
        'urn:li:person:me',
        'urn:li:share:card',
        'Thoughts?',
      );
      expect(result.metadata?.firstCommentUrn).toBe('urn:li:comment:1');
    });
  });

  describe('a link with no image of its own is unchanged', () => {
    it('stays plain text in the caption when only the caption has a link', async () => {
      await publisher.publish(
        options(
          { postType: 'post' },
          { content: 'Read https://lumiere.pk/blog' },
        ),
      );

      expect(service.createPost).toHaveBeenCalledTimes(1);
      expect(service.createPostWithLink).not.toHaveBeenCalled();
      expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
    });

    it('still takes the legacy ARTICLE branch when linkUrl is given without an image', async () => {
      await publisher.publish(
        options({
          postType: 'post',
          linkUrl: 'https://lumiere.pk/blog',
          linkTitle: 'Title',
        }),
      );

      expect(service.createPostWithLink).toHaveBeenCalledTimes(1);
      expect(service.createArticlePostWithThumbnail).not.toHaveBeenCalled();
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
