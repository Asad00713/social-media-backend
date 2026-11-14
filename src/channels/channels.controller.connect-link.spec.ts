/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- the controller is built with Object.create and its private collaborators are stubbed by name */
import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { channelLimitReached } from '../billing/services/channel-limit.error';
import { ChannelsController } from './channels.controller';
import { ConnectLinkConnectService } from './connect-links/connect-link-connect.service';
import {
  FacebookSelectionStore,
  fbSelectionKey,
  type SelectionRedis,
} from './connect-links/facebook-selection.store';
import { connectLinkError } from './connect-links/lib/connect-link-errors';
import { X_MEDIA_DECLINED_MESSAGE } from './connect-links/lib/callback-target';
import type { ResolvedConnectLink } from './connect-links/connect-link-access.service';

/**
 * The OAuth callback for a state started from a client's link page
 * (`/c/<token>`): every channel is created server-side with the link mark,
 * no token ever reaches the browser, and every outcome - success, Facebook
 * selection, refusal, the client cancelling on the network - lands back on
 * the link page. A team connect (no link) keeps its old redirects.
 */

const FE = 'https://app.schedura.test';
const TOKEN = 'Zk3v_-Q9pLmN0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';
const LINK_PAGE = `${FE}/c/${TOKEN}`;
const WS = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const ACCESS = 'ACCESS-TOKEN-SECRET-123';
const REFRESH = 'REFRESH-TOKEN-SECRET-456';
const STATE = 'state-token-abcdefghijkl';

const MARK = { connectLink: { linkId: LINK, email: 'client@example.com' } };

const NETWORKS = [
  'instagram',
  'facebook',
  'tiktok',
  'linkedin',
  'youtube',
  'pinterest',
  'threads',
  'twitter',
];

function resolvedLink(networks = NETWORKS): ResolvedConnectLink {
  return {
    link: {
      id: LINK,
      workspaceId: WS,
      createdByUserId: SENDER,
      email: 'client@example.com',
      networks,
    } as unknown as ResolvedConnectLink['link'],
    workspace: { id: WS, name: 'Acme Agency' },
    sender: { id: SENDER, name: 'Sam Sender', email: 'sam@agency.test' },
  };
}

function fakeRedis() {
  const store = new Map<string, string>();
  const redis: SelectionRedis = {
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
  return { redis, store };
}

interface BuildOpts {
  /** additionalData of the stored state; default = from the link. */
  additionalData?: Record<string, unknown> | null;
  resolveById?: jest.Mock;
  rawToken?: string | null;
  createChannel?: jest.Mock;
  networks?: string[];
  /** The platform the stored state was started for; default = the path's. */
  statePlatform?: string;
  /** Who the stored state was started for; default = the link's own. */
  stateWorkspaceId?: string;
  stateUserId?: string;
}

function build(opts: BuildOpts = {}) {
  const c: any = Object.create(ChannelsController.prototype);
  c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const additionalData =
    opts.additionalData === undefined
      ? { connectLinkId: LINK, intent: 'connect' }
      : opts.additionalData;

  let pathPlatform = 'linkedin';
  const stateWorkspaceId = opts.stateWorkspaceId ?? WS;
  const stateUserId = opts.stateUserId ?? SENDER;
  const validateState = jest.fn(() =>
    Promise.resolve({
      workspaceId: stateWorkspaceId,
      userId: stateUserId,
      platform: opts.statePlatform ?? pathPlatform,
      codeVerifier: null,
      redirectUrl: null,
      additionalData,
    }),
  );
  const peekState = jest.fn().mockResolvedValue({
    workspaceId: stateWorkspaceId,
    userId: stateUserId,
    additionalData,
  });
  const exchangeCodeForTokens = jest.fn().mockResolvedValue({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresIn: 3600,
    tokenType: 'bearer',
    scope: null,
  });
  c.oauthService = { validateState, peekState, exchangeCodeForTokens };

  const createChannel =
    opts.createChannel ??
    jest.fn((_ws: string, _user: string, dto: { platform: string }) =>
      Promise.resolve({
        id: 21,
        platform: dto.platform,
        accountName: 'Client Account',
      }),
    );
  const createOAuthState = jest.fn().mockResolvedValue(undefined);
  const getOAuthStateByToken = jest.fn();
  const getChannelById = jest.fn().mockResolvedValue({ id: 21, metadata: {} });
  const updateChannel = jest.fn().mockResolvedValue(undefined);
  const markOAuthStateUsed = jest.fn().mockResolvedValue(undefined);
  c.channelService = {
    createChannel,
    createOAuthState,
    getOAuthStateByToken,
    getChannelById,
    updateChannel,
    markOAuthStateUsed,
  };

  // The link row is LINK, in WS, sent by SENDER: a state for anyone else is
  // not that link's (the service's own rule is pinned in its spec).
  const linkOfState = jest.fn(
    (_id: string, owner: { workspaceId: string; userId: string }) => {
      if (opts.rawToken === null) return Promise.resolve({ status: 'missing' });
      if (owner.workspaceId !== WS || owner.userId !== SENDER) {
        return Promise.resolve({ status: 'foreign' });
      }
      return Promise.resolve({
        status: 'own',
        rawToken: opts.rawToken ?? TOKEN,
      });
    },
  );
  const resolveById =
    opts.resolveById ??
    jest.fn().mockResolvedValue(resolvedLink(opts.networks));
  c.connectLinkAccess = { linkOfState, resolveById };

  const channelConnect = {
    connectLinkedIn: jest.fn().mockResolvedValue({
      id: 9,
      platform: 'linkedin',
      accountName: 'Client Co',
    }),
    connectYouTube: jest.fn().mockResolvedValue({
      id: 10,
      platform: 'youtube',
      accountName: 'Client Tube',
    }),
    connectPinterest: jest.fn().mockResolvedValue({
      id: 11,
      platform: 'pinterest',
      accountName: 'Client Pins',
    }),
  };
  const { redis, store } = fakeRedis();
  const channelConnected = jest.fn().mockResolvedValue(undefined);
  c.connectLinkConnect = new ConnectLinkConnectService(
    channelConnect as any,
    new FacebookSelectionStore(redis),
    { channelConnected } as any,
    {} as any, // ConnectLinkAccessService: the callback resolves the link itself
  );

  c.instagramService = {
    exchangeForLongLivedToken: jest
      .fn()
      .mockResolvedValue({ accessToken: 'LONG-' + ACCESS, expiresIn: 5000 }),
    getAccountInfoWithUserToken: jest.fn().mockResolvedValue({
      id: 'ig-1',
      name: 'Client IG',
      username: 'client_ig',
    }),
  };
  c.threadsService = {
    getUserProfile: jest
      .fn()
      .mockResolvedValue({ id: 'th-1', name: 'Client T', username: 'ct' }),
  };
  c.tiktokService = {
    getCurrentUser: jest.fn().mockResolvedValue({
      id: 'tt-1',
      displayName: 'Client TT',
      username: 'ctt',
    }),
  };
  c.twitterService = {
    getCurrentUser: jest.fn().mockResolvedValue({
      id: 'x-1',
      name: 'Client X',
      username: 'cx',
      publicMetrics: {},
    }),
    getOAuth1RequestToken: jest.fn().mockResolvedValue({
      oauthToken: 'oauth1-token',
      oauthTokenSecret: 'oauth1-secret',
      authorizationUrl: 'https://api.x.test/oauth/authorize?oauth_token=t',
    }),
    getOAuth1AccessToken: jest.fn().mockResolvedValue({
      oauthToken: 'o-tok',
      oauthTokenSecret: 'o-sec',
    }),
  };

  const res = { redirect: jest.fn() };
  const callback = (
    platform: string,
    q: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      error_code?: string;
      error_message?: string;
    } = { code: 'the-code', state: STATE },
  ) => {
    pathPlatform = platform;
    return c.oauthCallback(
      platform,
      q.code,
      q.state,
      q.error,
      q.error_description,
      q.error_code,
      q.error_message,
      q,
      res,
    );
  };
  const redirected = (): string => {
    expect(res.redirect).toHaveBeenCalledTimes(1);
    return res.redirect.mock.calls[0][0] as string;
  };

  return {
    c,
    res,
    callback,
    redirected,
    validateState,
    peekState,
    exchangeCodeForTokens,
    createChannel,
    createOAuthState,
    getOAuthStateByToken,
    resolveById,
    linkOfState,
    channelConnect,
    channelConnected,
    store,
  };
}

describe('ChannelsController.oauthCallback - connect link states', () => {
  const ORIGINAL_ENV = { ...process.env };
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  beforeAll(() => {
    process.env.FRONTEND_URL = FE;
    process.env.APP_URL = 'https://api.schedura.test';
    process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('linkedin link state creates the channel server-side with the mark and redirects to /c/<token>?connected=linkedin&channelId=', async () => {
    const t = build();
    await t.callback('linkedin');
    expect(t.redirected()).toBe(`${LINK_PAGE}?connected=linkedin&channelId=9`);
    expect(t.channelConnect.connectLinkedIn).toHaveBeenCalledWith(
      WS,
      SENDER,
      expect.objectContaining({ accessToken: ACCESS, refreshToken: REFRESH }),
      MARK,
    );
    // the link is re-checked by id before anything is exchanged
    expect(t.resolveById).toHaveBeenCalledWith(LINK);
    expect(t.channelConnected).toHaveBeenCalledTimes(1);
    expect(t.channelConnected).toHaveBeenCalledWith(
      SENDER,
      'LinkedIn',
      'Client Co',
      WS,
    );
  });

  it.each([
    ['youtube', 'connectYouTube', 10],
    ['pinterest', 'connectPinterest', 11],
  ] as const)(
    '%s link state is connected server-side too',
    async (platform, method, id) => {
      const t = build();
      await t.callback(platform);
      expect(t.redirected()).toBe(
        `${LINK_PAGE}?connected=${platform}&channelId=${id}`,
      );
      expect(t.channelConnect[method]).toHaveBeenCalledWith(
        WS,
        SENDER,
        expect.objectContaining({ accessToken: ACCESS }),
        MARK,
      );
    },
  );

  it('no tokens in any link-state redirect', async () => {
    const urls: string[] = [];
    for (const platform of [
      'linkedin',
      'youtube',
      'pinterest',
      'facebook',
      'instagram',
      'threads',
      'tiktok',
    ]) {
      const t = build();
      await t.callback(platform);
      urls.push(t.redirected());
    }
    // a failure on the default flow too
    const failing = build();
    failing.channelConnect.connectLinkedIn.mockRejectedValue(
      new Error('LinkedIn is down'),
    );
    await failing.callback('linkedin');
    urls.push(failing.redirected());

    for (const url of urls) {
      expect(url.startsWith(`${LINK_PAGE}?`)).toBe(true);
      expect(url).not.toContain('accessToken=');
      expect(url).not.toContain('refreshToken=');
      expect(url).not.toContain(ACCESS);
      expect(url).not.toContain(REFRESH);
      expect(url).not.toContain('workspaceId=');
    }
  });

  it('facebook link state stores a selection and redirects with ?selection=', async () => {
    const t = build();
    await t.callback('facebook');
    const url = t.redirected();
    const m = /^(.*)\?selection=([A-Za-z0-9_-]{32})$/.exec(url);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(LINK_PAGE);
    const stored = t.store.get(fbSelectionKey(m![2]));
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!) as {
      linkId: string;
      userAccessToken: string;
    };
    expect(parsed.linkId).toBe(LINK);
    // encrypted at rest, never the plain user token
    expect(stored).not.toContain(ACCESS);
    expect(t.createChannel).not.toHaveBeenCalled();
    // nothing connected yet, so nobody is told yet
    expect(t.channelConnected).not.toHaveBeenCalled();
  });

  it('link cancelled during the OAuth round-trip redirects to /c/<token>?code=LINK_REVOKED', async () => {
    const t = build({
      resolveById: jest
        .fn()
        .mockRejectedValue(
          connectLinkError('LINK_REVOKED', 'This link was cancelled.'),
        ),
    });
    await t.callback('linkedin');
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=This%20link%20was%20cancelled.&code=LINK_REVOKED`,
    );
    // the code is never spent on a dead link
    expect(t.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(t.channelConnect.connectLinkedIn).not.toHaveBeenCalled();
  });

  it('an expired link mid-flow answers LINK_EXPIRED on the link page', async () => {
    const t = build({
      resolveById: jest
        .fn()
        .mockRejectedValue(
          connectLinkError('LINK_EXPIRED', 'This link has expired.'),
        ),
    });
    await t.callback('instagram');
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=This%20link%20has%20expired.&code=LINK_EXPIRED`,
    );
  });

  it('a network error with a link state returns to the link page', async () => {
    const t = build();
    await t.callback('linkedin', {
      error: 'access_denied',
      error_description: 'The user cancelled LinkedIn login',
      state: STATE,
    });
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=The%20user%20cancelled%20LinkedIn%20login&code=NETWORK_DECLINED`,
    );
    expect(t.peekState).toHaveBeenCalledWith(STATE);
    // peeked, not consumed
    expect(t.validateState).not.toHaveBeenCalled();
  });

  it('a Facebook error_code with a link state returns to the link page', async () => {
    const t = build();
    await t.callback('facebook', {
      error_code: '200',
      error_message: 'Permissions error',
      state: STATE,
    });
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=Permissions%20error&code=NETWORK_DECLINED`,
    );
    expect(t.validateState).not.toHaveBeenCalled();
  });

  it('a network error on a team state keeps the old error page', async () => {
    const t = build({ additionalData: { intent: 'connect' } });
    await t.callback('linkedin', {
      error: 'access_denied',
      error_description: 'denied',
      state: STATE,
    });
    expect(t.redirected()).toBe(
      `${FE}/channels/connect/error?error=access_denied&description=denied`,
    );
  });

  it('a state that fails validation still returns a link visitor to the link page', async () => {
    const t = build();
    t.validateState.mockRejectedValue(new Error('OAuth state already used'));
    await t.callback('linkedin');
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=OAuth%20state%20already%20used`,
    );
  });

  it('a state that expired 20 minutes ago still redirects to /c/<token>?error=', async () => {
    // The visitor waited on the network's login page past the state's 15
    // minutes: validateState refuses it, peekState (grace period) still reads
    // it, so the visitor lands on the link page, not the team error page.
    const t = build();
    t.validateState.mockRejectedValue(new Error('OAuth state has expired'));
    await t.callback('linkedin');
    expect(t.peekState).toHaveBeenCalledWith(STATE);
    expect(t.redirected()).toBe(
      `${LINK_PAGE}?error=OAuth%20state%20has%20expired`,
    );
    expect(t.channelConnect.connectLinkedIn).not.toHaveBeenCalled();
  });

  it('healthy duplicate maps to ALREADY_CONNECTED', async () => {
    // auto-create branch (Instagram Business Login)
    const ig = build({
      createChannel: jest
        .fn()
        .mockRejectedValue(
          new ConflictException(
            'This instagram account is already connected to this workspace',
          ),
        ),
    });
    await ig.callback('instagram');
    const igUrl = ig.redirected();
    expect(igUrl.startsWith(`${LINK_PAGE}?error=`)).toBe(true);
    expect(igUrl.endsWith('&code=ALREADY_CONNECTED')).toBe(true);
    expect(ig.channelConnected).not.toHaveBeenCalled();

    // default flow (LinkedIn via ChannelConnectService)
    const li = build();
    li.channelConnect.connectLinkedIn.mockRejectedValue(
      new ConflictException('already connected'),
    );
    await li.callback('linkedin');
    expect(li.redirected()).toBe(
      `${LINK_PAGE}?error=already%20connected&code=ALREADY_CONNECTED`,
    );
  });

  it('the channel limit keeps its code on the link page', async () => {
    const t = build({
      createChannel: jest.fn().mockRejectedValue(channelLimitReached(3, 3)),
    });
    await t.callback('tiktok');
    expect(t.redirected().endsWith('&code=CHANNEL_LIMIT_REACHED')).toBe(true);
    expect(t.redirected().startsWith(`${LINK_PAGE}?error=`)).toBe(true);
  });

  it.each([
    ['instagram', 'Instagram', 'Client IG'],
    ['threads', 'Threads', 'Client T'],
    ['tiktok', 'TikTok', 'Client TT'],
  ])(
    '%s link state marks the auto-created channel and notifies the sender',
    async (platform, label) => {
      const t = build();
      await t.callback(platform);
      expect(t.redirected()).toBe(
        `${LINK_PAGE}?connected=${platform}&channelId=21`,
      );
      expect(t.createChannel).toHaveBeenCalledWith(
        WS,
        SENDER,
        expect.objectContaining({ platform }),
        MARK,
      );
      expect(t.channelConnected).toHaveBeenCalledWith(
        SENDER,
        label,
        'Client Account',
        WS,
      );
    },
  );

  it('a sender notification that fails does not fail the connect', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const t = build();
      t.channelConnected.mockRejectedValue(new Error('socket down'));
      await t.callback('linkedin');
      expect(t.redirected()).toBe(
        `${LINK_PAGE}?connected=linkedin&channelId=9`,
      );
      expect(warn).toHaveBeenCalledWith(
        `Connect-link notification failed for link ${LINK}: socket down`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a link state started for another platform is an invalid state: nothing exchanged', async () => {
    const t = build({ statePlatform: 'facebook' });
    await t.callback('linkedin');
    const url = t.redirected();
    expect(url.startsWith(`${LINK_PAGE}?error=`)).toBe(true);
    expect(url).not.toContain('code=');
    expect(t.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(t.channelConnect.connectLinkedIn).not.toHaveBeenCalled();
  });

  it('a team state is not held to the platform check (unchanged)', async () => {
    const t = build({
      additionalData: { intent: 'connect' },
      statePlatform: 'facebook',
    });
    await t.callback('linkedin');
    expect(t.exchangeCodeForTokens).toHaveBeenCalled();
  });

  it('never logs the full state token or the authorization code', async () => {
    const t = build();
    await t.callback('linkedin', { code: 'secret-auth-code', state: STATE });
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(logged).toContain('ALL Query params');
    expect(logged).not.toContain(STATE);
    expect(logged).not.toContain('secret-auth-code');
  });

  it('a platform the link does not offer -> NETWORK_NOT_OFFERED, nothing exchanged', async () => {
    const t = build({ networks: ['instagram'] });
    await t.callback('linkedin');
    expect(t.redirected()).toMatch(
      new RegExp(`^${LINK_PAGE}\\?error=.*&code=NETWORK_NOT_OFFERED$`),
    );
    expect(t.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('a non-social platform on a link state -> NETWORK_NOT_OFFERED (slack)', async () => {
    const t = build();
    await t.callback('slack');
    expect(t.redirected()).toMatch(/&code=NETWORK_NOT_OFFERED$/);
    expect(t.createChannel).not.toHaveBeenCalled();
  });

  it('a state naming a link that no longer exists never runs as a team connect', async () => {
    const t = build({
      rawToken: null,
      resolveById: jest
        .fn()
        .mockRejectedValue(
          connectLinkError('LINK_NOT_FOUND', 'This link does not exist.'),
        ),
    });
    await t.callback('linkedin');
    const url = t.redirected();
    expect(url).toContain('code=LINK_NOT_FOUND');
    expect(url).not.toContain(ACCESS);
    expect(t.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  describe('a state that names a link it does not belong to (forged)', () => {
    // Only the public start writes a link state, always for the link's own
    // workspace and sender. A state that names some other workspace's link
    // (a team initiate that slipped connectLinkId in) is an invalid state:
    // refused before the code is spent, and never answered with /c/<token>.
    const OTHER_WS = '77777777-7777-4777-8777-777777777777';
    const OTHER_USER = '88888888-8888-4888-8888-888888888888';

    function expectTeamRefusal(t: ReturnType<typeof build>) {
      const url = t.redirected();
      expect(url.startsWith(`${FE}/channels/connect/error?`)).toBe(true);
      expect(url).not.toContain('/c/');
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain(encodeURIComponent(TOKEN));
      expect(t.exchangeCodeForTokens).not.toHaveBeenCalled();
      expect(t.createChannel).not.toHaveBeenCalled();
      expect(t.channelConnect.connectLinkedIn).not.toHaveBeenCalled();
      expect(t.channelConnected).not.toHaveBeenCalled();
    }

    it('a link state of another workspace is refused before the code exchange', async () => {
      const t = build({ stateWorkspaceId: OTHER_WS, stateUserId: OTHER_USER });
      await t.callback('linkedin');
      expectTeamRefusal(t);
      expect(t.redirected()).toContain('Invalid%20OAuth%20state');
      expect(t.linkOfState).toHaveBeenCalledWith(
        LINK,
        expect.objectContaining({ workspaceId: OTHER_WS, userId: OTHER_USER }),
      );
      // the link itself is never resolved for it
      expect(t.resolveById).not.toHaveBeenCalled();
    });

    it('a link state of the right workspace but another sender is refused too', async () => {
      const t = build({ stateUserId: OTHER_USER });
      await t.callback('linkedin');
      expectTeamRefusal(t);
    });

    it('auto-create networks (instagram) never create in either workspace', async () => {
      const t = build({ stateWorkspaceId: OTHER_WS, stateUserId: OTHER_USER });
      await t.callback('instagram');
      expectTeamRefusal(t);
      expect(
        t.c.instagramService.exchangeForLongLivedToken,
      ).not.toHaveBeenCalled();
    });

    it('a network ?error= on a forged state keeps the team error page (no /c/<token>)', async () => {
      const t = build({ stateWorkspaceId: OTHER_WS, stateUserId: OTHER_USER });
      await t.callback('linkedin', {
        error: 'x',
        error_description: 'y',
        state: STATE,
      });
      expect(t.redirected()).toBe(
        `${FE}/channels/connect/error?error=x&description=y`,
      );
      expect(t.peekState).toHaveBeenCalledWith(STATE);
    });

    it('a forged state that fails validation keeps the team error page', async () => {
      const t = build({ stateWorkspaceId: OTHER_WS, stateUserId: OTHER_USER });
      t.validateState.mockRejectedValue(new Error('OAuth state already used'));
      await t.callback('linkedin');
      const url = t.redirected();
      expect(url.startsWith(`${FE}/channels/connect/error?`)).toBe(true);
      expect(url).not.toContain('/c/');
    });

    it('defence in depth: a resolved link of another workspace is refused even if the lookup passed', async () => {
      const other = resolvedLink();
      (other.link as { workspaceId: string }).workspaceId = OTHER_WS;
      const t = build({ resolveById: jest.fn().mockResolvedValue(other) });
      await t.callback('linkedin');
      expectTeamRefusal(t);
    });

    it('a forged OAuth 1.0a state is answered on the team pages', async () => {
      const t = build();
      t.getOAuthStateByToken.mockResolvedValue({
        workspaceId: OTHER_WS,
        userId: OTHER_USER,
        codeVerifier: 'oauth1-secret',
        additionalData: { channelId: '21', connectLinkId: LINK },
      });
      await t.c.twitterOAuth1Callback(
        undefined,
        undefined,
        'oauth1-token',
        t.res,
      );
      const url = t.redirected();
      expect(url).toBe(
        `${FE}/channels/connect/error?error=User%20denied%20Twitter%20access`,
      );
    });
  });

  describe('twitter (OAuth 2.0 then the OAuth 1.0a chain)', () => {
    it('marks the channel, carries connectLinkId into the OAuth1 state', async () => {
      const t = build();
      await t.callback('twitter');
      expect(t.redirected()).toBe(
        'https://api.x.test/oauth/authorize?oauth_token=t',
      );
      expect(t.createChannel).toHaveBeenCalledWith(
        WS,
        SENDER,
        expect.objectContaining({ platform: 'twitter' }),
        MARK,
      );
      expect(t.createOAuthState).toHaveBeenCalledWith(
        WS,
        SENDER,
        'twitter',
        'oauth1-token',
        'https://api.schedura.test/channels/oauth/twitter/oauth1/callback',
        'oauth1-secret',
        { channelId: '21', connectLinkId: LINK },
      );
      expect(t.channelConnected).toHaveBeenCalledTimes(1);
    });

    it('the OAuth1 callback of a link goes back to /c/<token>?connected=twitter', async () => {
      const t = build();
      t.getOAuthStateByToken.mockResolvedValue({
        workspaceId: WS,
        userId: SENDER,
        codeVerifier: 'oauth1-secret',
        additionalData: { channelId: '21', connectLinkId: LINK },
      });
      await t.c.twitterOAuth1Callback(
        'oauth1-token',
        'verifier',
        undefined,
        t.res,
      );
      expect(t.redirected()).toBe(
        `${LINK_PAGE}?connected=twitter&channelId=21`,
      );
      // not a second "connected" notification for the same channel
      expect(t.channelConnected).not.toHaveBeenCalled();
    });

    it('an OAuth1 request-token failure on a link: the X channel stays connected, NETWORK_DECLINED', async () => {
      const t = build();
      t.c.twitterService.getOAuth1RequestToken.mockRejectedValue(
        new Error('X said no'),
      );
      await t.callback('twitter');
      expect(t.redirected()).toBe(
        `${LINK_PAGE}?error=${encodeURIComponent(X_MEDIA_DECLINED_MESSAGE)}&code=NETWORK_DECLINED`,
      );
      // the channel was created and announced, and is not undone
      expect(t.createChannel).toHaveBeenCalledTimes(1);
      expect(t.channelConnected).toHaveBeenCalledTimes(1);
    });

    it('a team OAuth1 request-token failure keeps the old error page', async () => {
      const t = build({ additionalData: { intent: 'connect' } });
      t.c.twitterService.getOAuth1RequestToken.mockRejectedValue(
        new Error('X said no'),
      );
      await t.callback('twitter');
      expect(t.redirected()).toBe(
        `${FE}/channels/connect/error?error=${encodeURIComponent('Twitter setup failed: X said no')}`,
      );
    });

    it('a duplicate X account on a link is still ALREADY_CONNECTED (not a media decline)', async () => {
      const t = build({
        createChannel: jest
          .fn()
          .mockRejectedValue(new ConflictException('already connected')),
      });
      await t.callback('twitter');
      expect(t.redirected()).toMatch(/&code=ALREADY_CONNECTED$/);
    });

    it('declining the OAuth1 step on a link returns to the link page', async () => {
      const t = build();
      t.getOAuthStateByToken.mockResolvedValue({
        workspaceId: WS,
        userId: SENDER,
        additionalData: { channelId: '21', connectLinkId: LINK },
      });
      await t.c.twitterOAuth1Callback(
        undefined,
        undefined,
        'oauth1-token',
        t.res,
      );
      expect(t.redirected()).toMatch(
        new RegExp(`^${LINK_PAGE}\\?error=.*&code=NETWORK_DECLINED$`),
      );
    });

    it('team OAuth1 callback is unchanged', async () => {
      const t = build();
      t.getOAuthStateByToken.mockResolvedValue({
        workspaceId: WS,
        userId: SENDER,
        codeVerifier: 'oauth1-secret',
        additionalData: { channelId: '21' },
      });
      await t.c.twitterOAuth1Callback(
        'oauth1-token',
        'verifier',
        undefined,
        t.res,
      );
      expect(t.redirected()).toBe(
        `${FE}/channels/connect/success?platform=twitter&oauth1=true&channelId=21`,
      );
    });

    it('team twitter OAuth1 state carries only the channel id', async () => {
      const t = build({ additionalData: { intent: 'connect' } });
      await t.callback('twitter');
      expect(t.createOAuthState.mock.calls[0][6]).toEqual({ channelId: '21' });
      expect(t.createChannel.mock.calls[0][3]).toBeUndefined();
    });
  });

  describe('team (non-link) connects are unchanged', () => {
    it('team (non-link) default flow still redirects with tokens to /channels/connect/success', async () => {
      const t = build({ additionalData: { intent: 'connect' } });
      const before = Date.now();
      await t.callback('linkedin');
      const url = new URL(t.redirected());
      expect(`${url.origin}${url.pathname}`).toBe(
        `${FE}/channels/connect/success`,
      );
      expect(url.searchParams.get('platform')).toBe('linkedin');
      expect(url.searchParams.get('workspaceId')).toBe(WS);
      expect(url.searchParams.get('accessToken')).toBe(ACCESS);
      expect(url.searchParams.get('refreshToken')).toBe(REFRESH);
      const expiresAt = Date.parse(url.searchParams.get('expiresAt')!);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 2000);
      expect([...url.searchParams.keys()]).toEqual([
        'platform',
        'workspaceId',
        'accessToken',
        'refreshToken',
        'expiresAt',
      ]);
      expect(t.resolveById).not.toHaveBeenCalled();
      expect(t.channelConnect.connectLinkedIn).not.toHaveBeenCalled();
    });

    it('team auto-create success URL is the old one, with no link mark', async () => {
      const t = build({ additionalData: { intent: 'connect' } });
      await t.callback('instagram');
      expect(t.redirected()).toBe(
        `${FE}/channels/connect/success?platform=instagram&channelId=21`,
      );
      expect(t.createChannel.mock.calls[0][3]).toBeUndefined();
      expect(t.channelConnected).not.toHaveBeenCalled();
    });

    it('a team inner catch keeps the old message and now also carries a code', async () => {
      const plain = build({
        additionalData: { intent: 'connect' },
        createChannel: jest.fn().mockRejectedValue(new Error('boom')),
      });
      await plain.callback('threads');
      expect(plain.redirected()).toBe(
        `${FE}/channels/connect/error?error=${encodeURIComponent('Threads setup failed: boom')}`,
      );

      const limited = build({
        additionalData: { intent: 'connect' },
        createChannel: jest.fn().mockRejectedValue(channelLimitReached(3, 3)),
      });
      await limited.callback('threads');
      expect(limited.redirected()).toMatch(/&code=CHANNEL_LIMIT_REACHED$/);
    });

    it('a team healthy duplicate is not relabelled (old string, no code)', async () => {
      const t = build({
        additionalData: { intent: 'connect' },
        createChannel: jest
          .fn()
          .mockRejectedValue(new ConflictException('already connected')),
      });
      await t.callback('tiktok');
      expect(t.redirected()).toBe(
        `${FE}/channels/connect/error?error=${encodeURIComponent('TikTok setup failed: already connected')}`,
      );
    });
  });
});
