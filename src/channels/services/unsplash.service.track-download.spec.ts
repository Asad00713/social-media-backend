import { BadRequestException } from '@nestjs/common';
import { fetch as undiciFetch } from 'undici';

// No real request may leave a test: undici's fetch (the guarded path) and the
// global fetch are both stubbed.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { publicAgent } from '../../common/net/public-fetch';
import { UnsplashService } from './unsplash.service';

/**
 * POST /channels/unsplash/download hands `downloadLocation` from the body to
 * trackDownload, which appends our access key. Only a genuine
 * https://api.unsplash.com URL may be called: anything else would leak the
 * key and make the route an open request proxy.
 */
const KEY = 'test-unsplash-key';
let savedKey: string | undefined;
let globalFetch: jest.SpyInstance;
beforeEach(() => {
  savedKey = process.env.UNSPLASH_ACCESS_KEY;
  process.env.UNSPLASH_ACCESS_KEY = KEY;
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => {
  process.env.UNSPLASH_ACCESS_KEY = savedKey;
  jest.restoreAllMocks();
});

describe('UnsplashService.trackDownload', () => {
  const service = new UnsplashService();

  it.each([
    ['an attacker host', 'https://evil.example/photos/x/download'],
    [
      'api.unsplash.com as a prefix',
      'https://api.unsplash.com.evil.example/photos/x/download',
    ],
    [
      'api.unsplash.com as a suffix',
      'https://evilapi.unsplash.com/photos/x/download',
    ],
    ['a subdomain of it', 'https://x.api.unsplash.com/photos/x/download'],
    ['userinfo', 'https://user:pw@api.unsplash.com/photos/x/download'],
    ['userinfo before an evil host', 'https://api.unsplash.com@evil.example/'],
    ['plain http', 'http://api.unsplash.com/photos/x/download'],
    ['another port', 'https://api.unsplash.com:8443/photos/x/download'],
    ['a private IP', 'https://169.254.169.254/latest/meta-data/'],
    ['a loopback IP', 'http://127.0.0.1:6379/'],
    ['garbage', 'not a url'],
  ])('refuses %s with a 400 and sends nothing', async (_what, url) => {
    await expect(service.trackDownload(url)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('pings a real api.unsplash.com URL through the pinned agent, redirects manual', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await service.trackDownload(
      'https://api.unsplash.com/photos/Dwu85P9SOIk/download?ixid=abc',
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { redirect: string; dispatcher: unknown },
    ];
    const sent = new URL(url);
    expect(sent.origin).toBe('https://api.unsplash.com');
    expect(sent.pathname).toBe('/photos/Dwu85P9SOIk/download');
    expect(sent.searchParams.get('ixid')).toBe('abc');
    expect(sent.searchParams.get('client_id')).toBe(KEY);
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(publicAgent);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('replaces a client_id smuggled into the URL with ours', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await service.trackDownload(
      'https://api.unsplash.com/photos/x/download?client_id=theirs',
    );
    const [url] = mockedFetch.mock.calls[0] as [string];
    expect(new URL(url).searchParams.getAll('client_id')).toEqual([KEY]);
  });
});
