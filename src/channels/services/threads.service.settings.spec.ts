import { ThreadsService } from './threads.service';

/**
 * These assert the HTTP BODY rather than the settings object.
 *
 * The publisher's tests pass camelCase settings straight through, so they
 * stay green against a snake_case typo — and a container-create is a form
 * POST where every value has to arrive as a string. Only this layer can
 * see either mistake.
 */
describe('ThreadsService — settings on the container body', () => {
  let service: ThreadsService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new ThreadsService();

    // Every create is container-then-publish, so both calls answer.
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-or-post' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** The parsed body of the Nth POST, 0-indexed. */
  const bodyOf = (n: number) =>
    JSON.parse(fetchMock.mock.calls[n][1].body as string);

  describe('a text post', () => {
    it('names every setting as Threads spells it', async () => {
      await service.createTextThread('token', 'user', 'hi', undefined, {
        replyControl: 'mentioned_only',
        topicTag: 'photography',
        isSpoilerMedia: true,
        enableReplyApprovals: true,
        locationId: 'loc-1',
      });

      const body = bodyOf(0);
      expect(body.reply_control).toBe('mentioned_only');
      expect(body.topic_tag).toBe('photography');
      expect(body.is_spoiler_media).toBe('true');
      expect(body.enable_reply_approvals).toBe('true');
      expect(body.location_id).toBe('loc-1');
    });

    // A form POST carries strings. A raw boolean would be serialised as
    // `false` and read as a set value, which is the opposite of omitting it.
    it('sends the booleans as strings, not booleans', async () => {
      await service.createTextThread('token', 'user', 'hi', undefined, {
        isSpoilerMedia: true,
      });

      expect(typeof bodyOf(0).is_spoiler_media).toBe('string');
    });

    it('omits every setting key when none was given', async () => {
      await service.createTextThread('token', 'user', 'hi');

      const body = bodyOf(0);
      for (const key of [
        'reply_control',
        'topic_tag',
        'is_spoiler_media',
        'enable_reply_approvals',
        'location_id',
        'poll_attachment',
      ]) {
        expect(key in body).toBe(false);
      }
    });

    it('JSON-encodes the poll, which is the one structured parameter', async () => {
      await service.createTextThread('token', 'user', 'hi', undefined, {
        poll: { optionA: 'one', optionB: 'two', optionC: 'three' },
      });

      expect(JSON.parse(bodyOf(0).poll_attachment)).toEqual({
        option_a: 'one',
        option_b: 'two',
        option_c: 'three',
      });
    });

    it('leaves out the poll options nobody filled in', async () => {
      await service.createTextThread('token', 'user', 'hi', undefined, {
        poll: { optionA: 'one', optionB: 'two' },
      });

      const poll = JSON.parse(bodyOf(0).poll_attachment);
      expect('option_c' in poll).toBe(false);
      expect('option_d' in poll).toBe(false);
    });
  });

  it('puts the settings on an image container', async () => {
    await service.createImageThread(
      'token',
      'user',
      'https://example.test/a.jpg',
      'hi',
      undefined,
      { topicTag: 'coffee', isSpoilerMedia: true },
    );

    const body = bodyOf(0);
    expect(body.topic_tag).toBe('coffee');
    expect(body.is_spoiler_media).toBe('true');
  });

  // The one that is easy to get wrong. An item container describes its own
  // media; the post-level settings belong to the post. Putting `topic_tag`
  // on each slide would send it two to ten times for one post.
  describe('a carousel', () => {
    const publishCarousel = () =>
      service.createCarouselThread(
        'token',
        'user',
        [
          { type: 'IMAGE', url: 'https://example.test/a.jpg' },
          { type: 'IMAGE', url: 'https://example.test/b.jpg' },
        ],
        'hi',
        undefined,
        { topicTag: 'coffee', isSpoilerMedia: true, replyControl: 'everyone' },
      );

    it('sends no settings on the item containers', async () => {
      await publishCarousel();

      // Calls 0 and 1 are the two item containers.
      for (const n of [0, 1]) {
        const body = bodyOf(n);
        expect(body.is_carousel_item).toBe('true');
        expect('topic_tag' in body).toBe(false);
        expect('is_spoiler_media' in body).toBe(false);
        expect('reply_control' in body).toBe(false);
      }
    });

    it('sends them on the parent container', async () => {
      await publishCarousel();

      // Call 2 is the parent: the one carrying `children`.
      const parent = bodyOf(2);
      expect(parent.media_type).toBe('CAROUSEL');
      expect(parent.topic_tag).toBe('coffee');
      expect(parent.is_spoiler_media).toBe('true');
      expect(parent.reply_control).toBe('everyone');
    });
  });
});
