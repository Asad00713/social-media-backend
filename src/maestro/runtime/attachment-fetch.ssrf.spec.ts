import { fetch as undiciFetch } from 'undici';

// Maestro attachment URLs come from the request body (MaestroAttachmentDto
// .url). Their bytes go to the model, so an unguarded fetch would read
// internal services back. They must go through fetchPublicMedia.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { BadRequestException } from '@nestjs/common';
import { publicAgent } from '../../common/net/public-fetch';
import { ClaudeAgentSdkRuntime } from './claude-agent-sdk.runtime';
import { MessagesApiRuntime } from './messages-api.runtime';

interface WithFetch {
  fetchBase64(url: string): Promise<string>;
}
const RUNTIMES: [string, () => WithFetch][] = [
  [
    'MessagesApiRuntime',
    () => new MessagesApiRuntime() as unknown as WithFetch,
  ],
  [
    'ClaudeAgentSdkRuntime',
    () => new ClaudeAgentSdkRuntime() as unknown as WithFetch,
  ],
];

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
});
afterEach(() => jest.restoreAllMocks());

describe.each(RUNTIMES)('%s attachment download', (_name, make) => {
  it.each([
    'http://127.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/iam/',
    'http://10.0.0.8/a.pdf',
    'http://[::1]/a.png',
  ])('refuses %s with a 400 and fetches nothing', async (url) => {
    const err: unknown = await make()
      .fetchBase64(url)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
    expect((err as BadRequestException).message).toBe(
      "That attachment link isn't reachable from the internet.",
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('downloads a public URL through the pinned agent', async () => {
    mockedFetch.mockResolvedValue(new Response('abc'));
    await expect(
      make().fetchBase64('https://93.184.216.34/a.png'),
    ).resolves.toBe(Buffer.from('abc').toString('base64'));
    const [, init] = mockedFetch.mock.calls[0] as [
      string,
      { dispatcher: unknown },
    ];
    expect(init.dispatcher).toBe(publicAgent);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe.each(RUNTIMES)('%s attachment errors', (_name, make) => {
  it('a body over the 50 MB cap is a 400 that says so', async () => {
    mockedFetch.mockResolvedValue(
      new Response('x', {
        headers: { 'content-length': String(60 * 1024 * 1024) },
      }),
    );
    const err: unknown = await make()
      .fetchBase64('https://93.184.216.34/a.png')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(
      'That attachment is too large.',
    );
  });

  it('a real network error is left as it is', async () => {
    const boom = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND'),
    });
    mockedFetch.mockRejectedValue(boom);
    await expect(
      make().fetchBase64('https://93.184.216.34/a.png'),
    ).rejects.toBe(boom);
  });
});
