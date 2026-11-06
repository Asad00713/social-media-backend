import {
  ThreadsService,
  THREADS_QUOTE_LOOKUP_PAGES,
  parseThreadsPostLink,
} from './threads.service';

/**
 * Where `quote_post_id` and `allowlisted_country_codes` land in the
 * container-create body, and how a quote link becomes a media id.
 */
describe('ThreadsService — quote a post, countries', () => {
  let service: ThreadsService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  const reply = (json: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
    });

  beforeEach(() => {
    service = new ThreadsService();
    fetchMock = jest.fn((url: string) =>
      String(url).includes('threads_publish')
        ? reply({ id: 'published' })
        : reply({ id: 'container' }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  /** The JSON body of the first container create. */
  const containerBody = () =>
    JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<
      string,
      string
    >;

  describe('the container body', () => {
    it('carries quote_post_id', async () => {
      await service.createTextThread('token', 'acct', 'hi', undefined, {
        quotePostId: '17890',
      });

      expect(containerBody().quote_post_id).toBe('17890');
    });

    it('carries the countries comma-joined, as Meta’s example does', async () => {
      await service.createTextThread('token', 'acct', 'hi', undefined, {
        allowlistedCountryCodes: ['US', 'CA'],
      });

      expect(containerBody().allowlisted_country_codes).toBe('US,CA');
    });

    it('leaves both out when unset', async () => {
      await service.createTextThread('token', 'acct', 'hi', undefined, {
        allowlistedCountryCodes: [],
      });

      const body = containerBody();
      expect('quote_post_id' in body).toBe(false);
      expect('allowlisted_country_codes' in body).toBe(false);
    });
  });

  describe('parseThreadsPostLink', () => {
    it.each([
      ['https://www.threads.com/@me/post/DAbc123', 'DAbc123'],
      ['https://threads.net/@me/post/C9x_Y-z?xmt=1', 'C9x_Y-z'],
    ])('reads %s', (link, code) => {
      expect(parseThreadsPostLink(link)).toBe(code);
    });

    it.each([
      'https://www.threads.com/@me',
      'https://www.instagram.com/p/DAbc123/',
      'threads.com/@me/post/DAbc123',
    ])('refuses %s', (link) => {
      expect(parseThreadsPostLink(link)).toBeNull();
    });
  });

  describe('findOwnPostByLink', () => {
    const LINK = 'https://www.threads.com/@me/post/WANTED';

    it('matches the shortcode among the account’s own posts', async () => {
      const getUserThreads = jest
        .spyOn(service, 'getUserThreads')
        .mockResolvedValueOnce({
          posts: [{ id: '1', shortcode: 'OTHER' } as never],
          nextCursor: 'c1',
        })
        .mockResolvedValueOnce({
          posts: [{ id: '17890', shortcode: 'WANTED' } as never],
          nextCursor: 'c2',
        });

      await expect(
        service.findOwnPostByLink('token', 'acct', LINK),
      ).resolves.toBe('17890');
      expect(getUserThreads).toHaveBeenNthCalledWith(
        1,
        'token',
        'acct',
        100,
        undefined,
      );
      expect(getUserThreads).toHaveBeenNthCalledWith(
        2,
        'token',
        'acct',
        100,
        'c1',
      );
    });

    it('stops after the last page', async () => {
      const getUserThreads = jest
        .spyOn(service, 'getUserThreads')
        .mockResolvedValue({ posts: [], nextCursor: null });

      await expect(
        service.findOwnPostByLink('token', 'acct', LINK),
      ).rejects.toThrow('only your own posts can be quoted');
      expect(getUserThreads).toHaveBeenCalledTimes(1);
    });

    it('looks no further than the page budget', async () => {
      const getUserThreads = jest
        .spyOn(service, 'getUserThreads')
        .mockResolvedValue({ posts: [], nextCursor: 'more' });

      await expect(
        service.findOwnPostByLink('token', 'acct', LINK),
      ).rejects.toThrow('not found');
      expect(getUserThreads).toHaveBeenCalledTimes(THREADS_QUOTE_LOOKUP_PAGES);
    });

    it('refuses a link that is not a Threads post without a request', async () => {
      const getUserThreads = jest.spyOn(service, 'getUserThreads');

      await expect(
        service.findOwnPostByLink('token', 'acct', 'https://x.com/a'),
      ).rejects.toThrow('is not a link to a Threads post');
      expect(getUserThreads).not.toHaveBeenCalled();
    });
  });
});
