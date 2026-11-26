/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the controller is built with Object.create and its private collaborators are set by name */
import 'reflect-metadata';

// No real request may leave a test: both fetches are stubbed.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));

const inserted: Record<string, unknown>[] = [];
let stored: Record<string, unknown> | undefined;
jest.mock('../drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(stored ? [stored] : []),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

import { CanvaController } from './canva.controller';

const FRONTEND = 'https://app.schedura.test';
const API = 'https://api.schedura.test';
const EVIL = 'https://evil.example/phish';
const CHAINED = `${API}/canva/oauth/callback?code=x&state=y`;

/**
 * The Canva flow stores the client's `redirectUrl` on the OAuth state and the
 * callback redirects to its origin, before the state is even checked for
 * expiry or reuse. Only the FRONTEND_URL origin may be stored or used.
 */
describe('CanvaController return URL', () => {
  const saved = {
    FRONTEND_URL: process.env.FRONTEND_URL,
    APP_URL: process.env.APP_URL,
  };

  function build() {
    const controller = Object.create(
      CanvaController.prototype,
    ) as CanvaController;
    const anyCtrl = controller as any;
    anyCtrl.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    anyCtrl.canvaService = {
      generateAuthUrl: () => ({ url: 'https://canva/auth', codeVerifier: 'v' }),
    };
    anyCtrl.access = { assertCan: () => Promise.resolve() };
    return controller;
  }

  beforeEach(() => {
    process.env.FRONTEND_URL = FRONTEND;
    process.env.APP_URL = API;
    inserted.length = 0;
    stored = undefined;
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
  });
  afterEach(() => {
    process.env.FRONTEND_URL = saved.FRONTEND_URL;
    process.env.APP_URL = saved.APP_URL;
    jest.restoreAllMocks();
  });

  describe('on store (initiate)', () => {
    const initiate = (redirectUrl?: string) =>
      build().initiateOAuth(
        { userId: 'u-1', workspaceId: 'ws-1' },
        { redirectUrl, workspaceId: 'ws-1' },
      );

    it.each([
      ['an evil origin', EVIL],
      ['the API origin’s Canva callback (chained)', CHAINED],
      ['a scheme-relative URL', '//evil.com/x'],
      ['nothing', undefined],
    ])('stores the frontend origin instead of %s', async (_what, url) => {
      await initiate(url);
      const kept = String(inserted[0]?.redirectUrl);
      expect(new URL(kept).origin).toBe(FRONTEND);
      expect(kept).not.toContain('evil');
      expect(kept).not.toContain('/canva/oauth/callback');
    });

    it('stores a frontend return URL', async () => {
      await initiate(`${FRONTEND}/library?tab=canva`);
      expect(inserted[0]?.redirectUrl).toBe(`${FRONTEND}/library?tab=canva`);
    });
  });

  describe('on use (callback)', () => {
    async function landing(redirectUrl: string, state: object = {}) {
      stored = {
        id: 's-1',
        workspaceId: 'ws-1',
        userId: 'u-1',
        redirectUrl,
        expiresAt: new Date(Date.now() - 60_000),
        ...state,
      };
      const res = { redirect: jest.fn() };
      await build().oauthCallback(
        'code',
        'state',
        undefined as unknown as string,
        undefined as unknown as string,
        res as unknown as Parameters<CanvaController['oauthCallback']>[4],
      );
      expect(res.redirect).toHaveBeenCalledTimes(1);
      return String(res.redirect.mock.calls[0][0]);
    }

    it.each([
      ['an evil origin', EVIL],
      ['the API origin’s Canva callback (chained)', CHAINED],
    ])(
      'a row stored with %s still lands on the frontend (expired state)',
      async (_what, url) => {
        const target = await landing(url);
        expect(new URL(target).origin).toBe(FRONTEND);
        expect(target).toContain('/canva/connect/error');
      },
    );

    it('a row stored with an evil origin lands on the frontend (used state)', async () => {
      const target = await landing(EVIL, {
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      });
      expect(new URL(target).origin).toBe(FRONTEND);
    });

    it('keeps the frontend origin of a valid stored return URL', async () => {
      const target = await landing(`${FRONTEND}/library`);
      expect(new URL(target).origin).toBe(FRONTEND);
    });
  });
});
