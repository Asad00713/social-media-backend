import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { fetch as undiciFetch } from 'undici';

// Every Mastodon request must leave through undici + publicAgent. Count those,
// and fail loudly if anything still reaches the unguarded global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { publicAgent } from '../../common/net/public-fetch';
import { MastodonService } from './mastodon.service';
import type { ResolvedChannel } from '../../inbox/adapters/inbox-adapter.interface';

const COPY = "That Mastodon server address isn't reachable from the internet.";
// IP literals are refused before any request. `localhost` by NAME is refused
// up front only where a user first types the address (registerApp); for a
// stored address it is refused at connect time (last test).
const PRIVATE_INSTANCES = [
  'http://127.0.0.1',
  '169.254.169.254',
  'https://10.0.0.8',
  'http://[::1]',
];
// A public IP literal: passes the guard without a DNS lookup.
const PUBLIC_INSTANCE = 'https://93.184.216.34';

const service = new MastodonService({
  get: () => undefined,
} as unknown as ConfigService);

type Call = (instance: string) => Promise<unknown>;
const CALLS: [string, Call][] = [
  ['registerApp', (i) => service.registerApp(i, 'https://app/cb')],
  [
    'exchangeCodeForToken',
    (i) => service.exchangeCodeForToken(i, 'id', 'secret', 'code', 'cb'),
  ],
  ['verifyCredentials', (i) => service.verifyCredentials(i, 'tok')],
  ['getAccount', (i) => service.getAccount(i, 'tok', '1')],
  ['createStatus', (i) => service.createStatus(i, 'tok', 'hello')],
  ['deleteStatus', (i) => service.deleteStatus(i, 'tok', '1')],
  ['setFavourite', (i) => service.setFavourite(i, 'tok', '1', true)],
  ['getAccountStatuses', (i) => service.getAccountStatuses(i, 'tok', '1')],
  ['revokeToken', (i) => service.revokeToken(i, 'id', 'secret', 'tok')],
  [
    'resolveStatusUrl',
    (i) => service.resolveStatusUrl(i, 'tok', 'https://x/1'),
  ],
  ['getStatusContext', (i) => service.getStatusContext(i, 'tok', '1')],
  [
    'listDirectConversations',
    (i) =>
      service.listDirectConversations({
        metadata: { instanceUrl: i },
        accessToken: 'tok',
      } as unknown as ResolvedChannel),
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

async function refusal(p: Promise<unknown>): Promise<BadRequestException> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return err as BadRequestException;
}

describe('MastodonService refuses a non-public server address', () => {
  describe.each(CALLS)('%s', (_name, call) => {
    it.each(PRIVATE_INSTANCES)(
      'refuses %s with a 400 and sends nothing',
      async (instance) => {
        const err = await refusal(call(instance));
        expect(err.message).toBe(COPY);
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
      },
    );

    it('sends a public server through the pinned agent, redirects manual', async () => {
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ id: '1', accounts: [], statuses: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await call(PUBLIC_INSTANCE).catch(() => undefined);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(mockedFetch).toHaveBeenCalled();
      for (const [url, init] of mockedFetch.mock.calls as [
        string,
        { redirect: string; dispatcher: unknown },
      ][]) {
        expect(url.startsWith(`${PUBLIC_INSTANCE}/`)).toBe(true);
        expect(init.redirect).toBe('manual');
        expect(init.dispatcher).toBe(publicAgent);
      }
    });
  });

  it('registerApp refuses localhost by name before any request', async () => {
    const err = await refusal(
      service.registerApp('http://localhost:8080', 'https://app/cb'),
    );
    expect(err.message).toBe(COPY);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('getApiVersion reads 0 for a private server, and sends nothing', async () => {
    await expect(service.getApiVersion('169.254.169.254')).resolves.toBe(0);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('does not follow a redirect: a 301 fails the call after one request', async () => {
    mockedFetch.mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'http://169.254.169.254/latest/' },
      }),
    );
    await refusal(service.registerApp(PUBLIC_INSTANCE, 'https://app/cb'));
    await refusal(service.verifyCredentials(PUBLIC_INSTANCE, 'tok'));
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('never reaches a loopback server named by hostname (connect-time check)', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    mockedFetch.mockImplementation(
      jest.requireActual<typeof import('undici')>('undici').fetch,
    );
    try {
      const err = await refusal(
        service.verifyCredentials(`http://localhost:${port}`, 'tok'),
      );
      expect(err.message).toBe(COPY);
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
