jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(),
}));
import { fetch as undiciFetch } from 'undici';
import { publicAgent } from '../../common/net/public-fetch';
import type { BlueskyService } from './bluesky.service';
import { MentionLookupService } from './mention-lookup.service';

// The composer's @-menu waits on this: a stalled Mastodon server must not
// hold it for undici's 300 s defaults. No real request may leave a test:
// undici's fetch and the global fetch are both stubbed.
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

const service = () =>
  new MentionLookupService({
    getProfile: jest.fn(),
  } as unknown as BlueskyService);

describe('MentionLookupService Mastodon deadline', () => {
  it('gets a 5 s signal, passed through the guard to undici', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ accounts: [{ acct: 'ann' }] })),
    );
    const result = await service().lookup(
      'mastodon',
      't',
      { instanceUrl: 'http://mastodon.social/' },
      '@ann',
    );
    expect(result.found).toBe(true);
    expect(timeout).toHaveBeenCalledWith(5_000);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { signal: AbortSignal; dispatcher: unknown; redirect: string },
    ];
    // A stored http:// address is still rewritten to https.
    expect(url.startsWith('https://mastodon.social/api/v2/search?')).toBe(true);
    expect(init.signal).toBe(timeout.mock.results[0].value);
    expect(init.dispatcher).toBe(publicAgent);
    expect(init.redirect).toBe('manual');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('a stalled server answers "not found" at the deadline', async () => {
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
    const pending = service().lookup(
      'mastodon',
      't',
      { instanceUrl: 'mastodon.social' },
      'ann',
    );
    setTimeout(() => ctrl.abort(), 10);
    await expect(settled(pending)).resolves.toEqual({
      handle: 'ann',
      found: false,
    });
  });

  it.each(['http://127.0.0.1', '169.254.169.254', 'https://[::1]:8443'])(
    'never asks the private stored server %s',
    async (instanceUrl) => {
      const result = await service().lookup(
        'mastodon',
        't',
        { instanceUrl },
        'ann',
      );
      expect(result).toEqual({ handle: 'ann', found: false });
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );
});
