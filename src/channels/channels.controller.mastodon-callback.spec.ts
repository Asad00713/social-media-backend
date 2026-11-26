/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the controller is built with Object.create and its private collaborators are set by name */
import 'reflect-metadata';

// No real request may leave a test: both fetches are stubbed.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));

let stateRedirectUrl: string | null = null;
jest.mock('../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: 's-1',
                workspaceId: 'ws-1',
                userId: 'u-1',
                redirectUrl: stateRedirectUrl,
                additionalData: {
                  instanceUrl: 'https://mastodon.example',
                  clientId: 'id',
                  clientSecret: 'secret',
                  redirectUri: 'https://api.schedura.test/cb',
                },
              },
            ]),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

import { ChannelsController } from './channels.controller';

const FRONTEND = 'https://app.schedura.test';
const API = 'https://api.schedura.test';

/**
 * The Mastodon callback redirects the browser to the `redirectUrl` the
 * initiate request stored. That value is client-supplied, so only one of our
 * own origins (FRONTEND_URL / APP_URL) is followed; anything else falls back
 * to the default path.
 */
describe('ChannelsController.mastodonOAuthCallback return URL', () => {
  const saved = {
    FRONTEND_URL: process.env.FRONTEND_URL,
    APP_URL: process.env.APP_URL,
  };
  let failExchange = false;

  function build() {
    const controller = Object.create(
      ChannelsController.prototype,
    ) as ChannelsController;
    const anyCtrl = controller as any;
    anyCtrl.mastodonService = {
      exchangeCodeForToken: jest.fn(() =>
        failExchange
          ? Promise.reject(new Error('Failed to authenticate with Mastodon'))
          : Promise.resolve({ accessToken: 't', scope: 'read' }),
      ),
      verifyCredentials: jest.fn(() =>
        Promise.resolve({ id: '1', username: 'ann', displayName: 'Ann' }),
      ),
    };
    anyCtrl.channelService = {
      createChannel: jest.fn(() => Promise.resolve()),
    };
    return controller;
  }

  async function landing(redirectUrl: string | null): Promise<string> {
    stateRedirectUrl = redirectUrl;
    const res = { redirect: jest.fn() };
    await build().mastodonOAuthCallback(
      'code',
      'state',
      res as unknown as Parameters<
        ChannelsController['mastodonOAuthCallback']
      >[2],
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    return String(res.redirect.mock.calls[0][0]);
  }

  beforeEach(() => {
    process.env.FRONTEND_URL = FRONTEND;
    process.env.APP_URL = API;
    failExchange = false;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
  });
  afterEach(() => {
    process.env.FRONTEND_URL = saved.FRONTEND_URL;
    process.env.APP_URL = saved.APP_URL;
    jest.restoreAllMocks();
  });

  it('follows a return URL on the frontend origin', async () => {
    expect(await landing(`${FRONTEND}/channels?tab=1`)).toBe(
      `${FRONTEND}/channels?tab=1&platform=mastodon&success=true`,
    );
  });

  it('follows a return URL on the API origin', async () => {
    expect(await landing(`${API}/done`)).toBe(
      `${API}/done?platform=mastodon&success=true`,
    );
  });

  it.each([
    ['an evil origin', 'https://evil.example/phish'],
    ['a relative path', '/dashboard'],
    ['a scheme-relative URL', '//evil.com/phish'],
  ])('falls back to the default path for %s', async (_what, url) => {
    expect(await landing(url)).toBe(
      '/channels/connect/success?platform=mastodon&success=true',
    );
  });

  it.each([
    ['an evil origin', 'https://evil.example/phish'],
    ['a relative path', '/dashboard'],
    ['a scheme-relative URL', '//evil.com/phish'],
  ])('falls back on the error path too, for %s', async (_what, url) => {
    failExchange = true;
    const target = await landing(url);
    expect(
      target.startsWith('/channels/connect/error?error=oauth_failed'),
    ).toBe(true);
  });

  it('keeps the default path when no return URL was stored', async () => {
    expect(await landing(null)).toBe(
      '/channels/connect/success?platform=mastodon&success=true',
    );
  });
});
