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
import { BlueskyService } from './bluesky.service';

/**
 * The video upload sends the user's access JWT to the PDS host named in the
 * account's DID document (`did:web:<host>`, or plc.directory's
 * `#atproto_pds` entry). That host is not ours to trust, so it must be a
 * public address, pinned at connect, with no redirect followed.
 */
interface VideoUploadInternals {
  uploadVideoViaService(
    accessJwt: string,
    did: string,
    videoBuffer: Buffer,
    mimeType: string,
    videoUrl: string,
    pdsHost: string,
  ): Promise<unknown>;
}

const COPY = "That Bluesky server address isn't reachable from the internet.";
const PRIVATE_HOSTS = [
  '127.0.0.1',
  '169.254.169.254',
  '10.0.0.8',
  '[::1]',
  '127.0.0.1:2583',
];

let service: BlueskyService;
let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
  service = new BlueskyService();
});
afterEach(() => jest.restoreAllMocks());

const upload = (pdsHost: string) =>
  (service as unknown as VideoUploadInternals).uploadVideoViaService(
    'user-access-jwt',
    'did:plc:abc',
    Buffer.from('video'),
    'video/mp4',
    'https://cdn.example/v.mp4',
    pdsHost,
  );

describe('Bluesky video upload: the PDS host from the DID document', () => {
  it.each(PRIVATE_HOSTS)(
    'refuses %s with a 400, and the token is never sent',
    async (host) => {
      const err: unknown = await upload(host).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(COPY);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it('refuses a did:web PDS on a private address end to end', async () => {
    // Only the video download (a public CDN) is answered.
    mockedFetch.mockResolvedValue(
      new Response('video', { headers: { 'content-type': 'video/mp4' } }),
    );
    const err: unknown = await service
      .createVideoPost(
        'user-access-jwt',
        'did:web:169.254.169.254',
        'hello',
        'https://93.184.216.34/v.mp4',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(COPY);
    expect((mockedFetch.mock.calls as [string][]).map(([url]) => url)).toEqual([
      'https://93.184.216.34/v.mp4',
    ]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('asks a public PDS through the pinned agent, redirects manual', async () => {
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ token: 'svc' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await upload('93.184.216.34').catch(() => undefined);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      {
        redirect: string;
        dispatcher: unknown;
        headers: Record<string, string>;
      },
    ];
    expect(url.startsWith('https://93.184.216.34/xrpc/')).toBe(true);
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(publicAgent);
    expect(init.headers.Authorization).toBe('Bearer user-access-jwt');
  });

  it('fails on a 3xx from the PDS instead of following it', async () => {
    mockedFetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/' },
      }),
    );
    await expect(upload('93.184.216.34')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
