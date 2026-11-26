// The Mastodon search goes through the SSRF guard (fetchPublic → undici).
// Hand undici's fetch to the global stub, so the guard itself still runs.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));

import { MentionLookupService } from './mention-lookup.service';
import { BlueskyService } from './bluesky.service';
import { publicAgent } from '../../common/net/public-fetch';

/**
 * The composer's check of a typed `@handle` for an account outside the
 * workspace, on Bluesky and Mastodon.
 */
describe('MentionLookupService', () => {
  let getProfile: jest.Mock;
  let service: MentionLookupService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  const reply = (json: unknown, ok = true) =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(json),
    });

  beforeEach(() => {
    getProfile = jest.fn();
    service = new MentionLookupService({
      getProfile,
    } as unknown as BlueskyService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('Bluesky', () => {
    it('finds a handle through getProfile', async () => {
      getProfile.mockResolvedValue({
        handle: 'ann.bsky.social',
        displayName: 'Ann',
        avatar: 'https://cdn/a.jpg',
      });

      const result = await service.lookup(
        'bluesky',
        'jwt',
        {},
        '@ann.bsky.social',
      );

      expect(getProfile).toHaveBeenCalledWith('jwt', 'ann.bsky.social');
      expect(result).toEqual({
        handle: 'ann.bsky.social',
        found: true,
        displayName: 'Ann',
        avatarUrl: 'https://cdn/a.jpg',
      });
    });

    it('says not found when the handle does not resolve', async () => {
      getProfile.mockRejectedValue(new Error('Profile not found'));

      await expect(
        service.lookup('bluesky', 'jwt', {}, 'nobody.example'),
      ).resolves.toEqual({ handle: 'nobody.example', found: false });
    });
  });

  describe('Mastodon', () => {
    const meta = { instanceUrl: 'mastodon.social' };

    it('searches accounts with resolve=true on the channel’s server', async () => {
      fetchMock.mockImplementation(() =>
        reply({
          accounts: [
            { acct: 'ann@other.social', display_name: 'Ann', avatar: 'a.png' },
          ],
        }),
      );

      const result = await service.lookup(
        'mastodon',
        'tok',
        meta,
        'ann@other.social',
      );

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.origin + url.pathname).toBe(
        'https://mastodon.social/api/v2/search',
      );
      expect(url.searchParams.get('q')).toBe('ann@other.social');
      expect(url.searchParams.get('type')).toBe('accounts');
      expect(url.searchParams.get('resolve')).toBe('true');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer tok',
      );
      expect(result).toEqual({
        handle: 'ann@other.social',
        found: true,
        displayName: 'Ann',
        avatarUrl: 'a.png',
      });
    });

    it('matches a local account typed with its own server', async () => {
      fetchMock.mockImplementation(() =>
        reply({ accounts: [{ acct: 'ann' }] }),
      );

      const result = await service.lookup(
        'mastodon',
        'tok',
        meta,
        'ann@mastodon.social',
      );

      expect(result.found).toBe(true);
    });

    it('does not take a fuzzy match for the account typed', async () => {
      fetchMock.mockImplementation(() =>
        reply({ accounts: [{ acct: 'annabel' }] }),
      );

      const result = await service.lookup('mastodon', 'tok', meta, 'ann');

      expect(result).toEqual({ handle: 'ann', found: false });
    });

    it('says not found when the search fails', async () => {
      fetchMock.mockImplementation(() => reply({}, false));

      expect((await service.lookup('mastodon', 'tok', meta, 'ann')).found).toBe(
        false,
      );
    });

    it.each([
      'http://127.0.0.1',
      '169.254.169.254',
      'https://10.0.0.8',
      'http://[::1]',
    ])(
      'says not found for a private server %s, and asks nothing',
      async (instanceUrl) => {
        expect(
          (await service.lookup('mastodon', 'tok', { instanceUrl }, 'ann'))
            .found,
        ).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('asks through the pinned agent and does not follow redirects', async () => {
      fetchMock.mockImplementation(() => reply({ accounts: [] }));
      await service.lookup('mastodon', 'tok', meta, 'ann');
      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { redirect: string; dispatcher: unknown },
      ];
      expect(init.redirect).toBe('manual');
      expect(init.dispatcher).toBe(publicAgent);
    });

    it('says not found without a server to ask', async () => {
      expect((await service.lookup('mastodon', 'tok', {}, 'ann')).found).toBe(
        false,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('checks nothing for an empty handle', async () => {
    await expect(service.lookup('bluesky', 'jwt', {}, '@ ')).resolves.toEqual({
      handle: '',
      found: false,
    });
    expect(getProfile).not.toHaveBeenCalled();
  });
});
