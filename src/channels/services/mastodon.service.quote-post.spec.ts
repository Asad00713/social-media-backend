import { ConfigService } from '@nestjs/config';
import { MastodonService } from './mastodon.service';

/**
 * Quoting a post on Mastodon 4.5+: the body field, the version probe and
 * the link lookup, at the level of the HTTP requests.
 */
describe('MastodonService — quote a post', () => {
  let service: MastodonService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  const reply = (json: unknown, ok = true, status = 200) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(json) });

  beforeEach(() => {
    service = new MastodonService({
      get: jest.fn(),
    } as unknown as ConfigService);
    fetchMock = jest.fn(() => reply({ id: '1', url: 'https://m.test/1' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('createStatus', () => {
    const bodyFor = async (
      options?: Parameters<MastodonService['createStatus']>[3],
    ) => {
      await service.createStatus('m.test', 'token', 'hello', options);
      return JSON.parse(fetchMock.mock.calls[0][1].body as string);
    };

    it('sends quoted_status_id as a top-level field', async () => {
      expect(await bodyFor({ quotedStatusId: '1099' })).toEqual({
        status: 'hello',
        quoted_status_id: '1099',
      });
    });

    it('leaves it out when there is no quote', async () => {
      expect('quoted_status_id' in (await bodyFor({}))).toBe(false);
    });
  });

  describe('getApiVersion', () => {
    it('reads api_versions.mastodon from /api/v2/instance', async () => {
      fetchMock.mockImplementation(() =>
        reply({ version: '4.5.0', api_versions: { mastodon: 7 } }),
      );

      expect(await service.getApiVersion('m.test')).toBe(7);
      expect(fetchMock.mock.calls[0][0]).toBe('https://m.test/api/v2/instance');
    });

    it('is 0 for a server that does not report one', async () => {
      fetchMock.mockImplementation(() => reply({ version: '4.2.1' }));

      expect(await service.getApiVersion('m.test')).toBe(0);
    });

    it('is 0 when the instance cannot be read', async () => {
      fetchMock.mockImplementation(() => reply({}, false, 404));
      expect(await service.getApiVersion('m.test')).toBe(0);

      fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
      expect(await service.getApiVersion('m.test')).toBe(0);
    });
  });

  describe('resolveStatusUrl', () => {
    const LINK = 'https://other.social/@ann/1234';

    it('searches statuses with resolve=true, as the user', async () => {
      fetchMock.mockImplementation(() =>
        reply({ statuses: [{ id: '9001' }], accounts: [] }),
      );

      const id = await service.resolveStatusUrl('m.test', 'token', LINK);

      expect(id).toBe('9001');
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.origin + url.pathname).toBe('https://m.test/api/v2/search');
      expect(url.searchParams.get('q')).toBe(LINK);
      expect(url.searchParams.get('type')).toBe('statuses');
      expect(url.searchParams.get('resolve')).toBe('true');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer token',
      );
    });

    it('refuses a link the server cannot find', async () => {
      fetchMock.mockImplementation(() => reply({ statuses: [] }));

      await expect(
        service.resolveStatusUrl('m.test', 'token', LINK),
      ).rejects.toThrow('could not be found');
    });

    it('reports a failed search', async () => {
      fetchMock.mockImplementation(() => reply({}, false, 401));

      await expect(
        service.resolveStatusUrl('m.test', 'token', LINK),
      ).rejects.toThrow('(401)');
    });
  });
});
