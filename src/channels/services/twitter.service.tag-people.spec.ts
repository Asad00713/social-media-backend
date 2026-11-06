import { ConfigService } from '@nestjs/config';
import { TwitterService } from './twitter.service';

/** Where `tagged_user_ids` lands in POST /2/tweets, and the username lookup. */
describe('TwitterService — tag people', () => {
  let service: TwitterService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  const reply = (json: unknown, ok = true) =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 429,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
    });

  beforeEach(() => {
    service = new TwitterService({
      get: jest.fn(),
    } as unknown as ConfigService);
    fetchMock = jest.fn(() => reply({ data: { id: '1', text: 'hi' } }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const body = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('puts tagged_user_ids inside `media`, beside media_ids', async () => {
    await service.createTweet('token', 'hi', {
      mediaIds: ['m1'],
      taggedUserIds: ['111', '222'],
    });

    expect(body().media).toEqual({
      media_ids: ['m1'],
      tagged_user_ids: ['111', '222'],
    });
    expect(body()).not.toHaveProperty('tagged_user_ids');
  });

  it('sends no tags without media', async () => {
    await service.createTweet('token', 'hi', { taggedUserIds: ['111'] });

    expect(body()).not.toHaveProperty('media');
  });

  it('leaves the key out when nobody is tagged', async () => {
    await service.createTweet('token', 'hi', {
      mediaIds: ['m1'],
      taggedUserIds: [],
    });

    expect(body().media).toEqual({ media_ids: ['m1'] });
  });

  describe('lookupUserIds', () => {
    it('asks /2/users/by once and keys ids by lower-cased username', async () => {
      fetchMock.mockImplementation(() =>
        reply({
          data: [{ id: '111', username: 'Ann_B', name: 'Ann' }],
          errors: [{ value: 'ghost', detail: 'Could not find user' }],
        }),
      );

      const ids = await service.lookupUserIds('token', ['ann_b', 'ghost']);

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/2/users/by');
      expect(url.searchParams.get('usernames')).toBe('ann_b,ghost');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer token',
      );
      expect([...ids]).toEqual([['ann_b', '111']]);
    });

    it('asks nothing for an empty list', async () => {
      expect((await service.lookupUserIds('token', [])).size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a failed lookup', async () => {
      fetchMock.mockImplementation(() => reply({}, false));

      await expect(service.lookupUserIds('token', ['a'])).rejects.toThrow(
        'X user lookup failed: 429',
      );
    });
  });
});
