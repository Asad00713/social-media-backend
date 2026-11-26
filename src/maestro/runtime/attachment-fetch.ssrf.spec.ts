import { fetch as undiciFetch } from 'undici';

// Maestro attachment URLs come from the request body (MaestroAttachmentDto
// .url). Their bytes go to the model, so an unguarded fetch would read
// internal services back. They must go through fetchPublicMedia.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

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
  ])('refuses %s and fetches nothing', async (url) => {
    await expect(make().fetchBase64(url)).rejects.toThrow();
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
