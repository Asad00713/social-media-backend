import { InstagramService } from './instagram.service';

/**
 * The form-urlencoded container body, which is the only place the
 * encoding is visible.
 *
 * These containers post `application/x-www-form-urlencoded`, so
 * `user_tags` is a JSON array serialised into one parameter. The
 * publisher's tests pass a camelCase object straight through and would
 * stay green against the wrong parameter name or an un-serialised array.
 */
describe('InstagramService — user_tags on the container body', () => {
  let service: InstagramService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new InstagramService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-1', status_code: 'FINISHED' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** The parsed form body of the Nth POST, 0-indexed. */
  const formOf = (n: number) => {
    const body = fetchMock.mock.calls[n][1].body as URLSearchParams;
    return new URLSearchParams(body.toString());
  };

  describe('a feed image', () => {
    it('serialises the tags as a JSON array', async () => {
      await service.createImagePostWithUserToken(
        'user',
        'token',
        'https://example.test/a.jpg',
        'caption',
        { userTags: [{ username: 'ada', x: 0.2, y: 0.8 }] },
      );

      expect(JSON.parse(formOf(0).get('user_tags')!)).toEqual([
        { username: 'ada', x: 0.2, y: 0.8 },
      ]);
    });

    // Meta makes `x` REQUIRED on an image: a tag without one is rejected,
    // which would lose the whole post rather than the tag.
    it('centres a tag that was never placed', async () => {
      await service.createImagePostWithUserToken(
        'user',
        'token',
        'https://example.test/a.jpg',
        undefined,
        { userTags: [{ username: 'ada' }] },
      );

      expect(JSON.parse(formOf(0).get('user_tags')!)).toEqual([
        { username: 'ada', x: 0.5, y: 0.5 },
      ]);
    });

    it('strips a leading @ from the username', async () => {
      await service.createImagePostWithUserToken(
        'user',
        'token',
        'https://example.test/a.jpg',
        undefined,
        { userTags: [{ username: '@ada', x: 0.1, y: 0.1 }] },
      );

      expect(JSON.parse(formOf(0).get('user_tags')!)[0].username).toBe('ada');
    });

    it('sends no parameter when there are no tags', async () => {
      await service.createImagePostWithUserToken(
        'user',
        'token',
        'https://example.test/a.jpg',
      );

      expect(formOf(0).has('user_tags')).toBe(false);
    });

    it('caps collaborators at three', async () => {
      await service.createImagePostWithUserToken(
        'user',
        'token',
        'https://example.test/a.jpg',
        undefined,
        { collaborators: ['a', 'b', 'c', 'd'] },
      );

      expect(JSON.parse(formOf(0).get('collaborators')!)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  // A story's coordinates are optional, unlike an image's — so an
  // unplaced mention stays unplaced rather than being centred.
  it('leaves a story mention unplaced when nothing placed it', async () => {
    await service.createStoryWithUserToken(
      'user',
      'token',
      'https://example.test/a.jpg',
      false,
      [{ username: 'ada' }],
    );

    expect(JSON.parse(formOf(0).get('user_tags')!)).toEqual([
      { username: 'ada' },
    ]);
  });

  describe('a reel', () => {
    const publishReel = (settings: Record<string, unknown>) =>
      service.createVideoPostWithUserToken(
        'user',
        'token',
        'https://example.test/v.mp4',
        'caption',
        false,
        'REELS',
        settings,
      );

    it('sends share_to_feed as given, including false', async () => {
      await publishReel({ shareToFeed: false });

      expect(formOf(0).get('share_to_feed')).toBe('false');
    });

    it('sends the cover url', async () => {
      await publishReel({ coverUrl: 'https://example.test/cover.jpg' });

      expect(formOf(0).get('cover_url')).toBe(
        'https://example.test/cover.jpg',
      );
    });
  });

  // Both are Reels-only. A plain VIDEO container carrying either is
  // rejected, so they must be dropped rather than forwarded.
  it('sends neither reel-only field on a plain video', async () => {
    await service.createVideoPostWithUserToken(
      'user',
      'token',
      'https://example.test/v.mp4',
      'caption',
      false,
      'VIDEO',
      { shareToFeed: true, coverUrl: 'https://example.test/cover.jpg' },
    );

    const form = formOf(0);
    expect(form.has('share_to_feed')).toBe(false);
    expect(form.has('cover_url')).toBe(false);
  });
});
