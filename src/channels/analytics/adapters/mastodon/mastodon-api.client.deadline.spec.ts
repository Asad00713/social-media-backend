jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(),
}));
import { fetch as undiciFetch } from 'undici';
import { publicAgent } from '../../../../common/net/public-fetch';
import { MastodonApiClient } from './mastodon-api.client';

// The analytics sync calls a user-named server: without a deadline a stalled
// one holds the job for undici's 300 s defaults. No real request may leave a
// test: undici's fetch and the global fetch are both stubbed.
const mockedFetch = undiciFetch as unknown as jest.Mock;
let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => jest.restoreAllMocks());

/** `p`, or a rejection if it has not settled shortly after the abort. */
function settled<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error('still hanging')), 200),
    ),
  ]);
}

const ok = () =>
  new Response(JSON.stringify({ id: '1' }), {
    headers: { 'content-type': 'application/json' },
  });

describe('MastodonApiClient deadlines', () => {
  const calls: [string, (c: MastodonApiClient) => Promise<unknown>][] = [
    ['verifyCredentials', (c) => c.verifyCredentials('mastodon.social', 't')],
    [
      'getAccountStatuses',
      (c) =>
        c.getAccountStatuses({
          instanceUrl: 'mastodon.social',
          accountId: '1',
          accessToken: 't',
        }),
    ],
    [
      'getStatus',
      (c) =>
        c.getStatus({
          instanceUrl: 'mastodon.social',
          statusId: '1',
          accessToken: 't',
        }),
    ],
  ];

  it.each(calls)(
    '%s gets a 15 s signal, passed through the guard to undici',
    async (_name, call) => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      mockedFetch.mockResolvedValue(ok());
      await call(new MastodonApiClient());
      expect(timeout).toHaveBeenCalledWith(15_000);
      const signal = timeout.mock.results[0].value as AbortSignal;
      const [url, init] = mockedFetch.mock.calls[0] as [
        string,
        { signal: AbortSignal; dispatcher: unknown; redirect: string },
      ];
      expect(url.startsWith('https://mastodon.social/')).toBe(true);
      expect(init.signal).toBe(signal);
      expect(init.dispatcher).toBe(publicAgent);
      expect(init.redirect).toBe('manual');
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it('a stalled server fails at the deadline instead of hanging', async () => {
    const ctrl = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(ctrl.signal);
    mockedFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          // No signal: the request hangs, as undici's would.
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          ),
        ),
    );
    const pending = new MastodonApiClient().verifyCredentials(
      'mastodon.social',
      't',
    );
    setTimeout(() => ctrl.abort(), 10);
    await expect(settled(pending)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('an injected transport is handed the signal too', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok()));
    await new MastodonApiClient(fetchImpl).verifyCredentials('a.example', 't');
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as {
      signal?: unknown;
    };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
