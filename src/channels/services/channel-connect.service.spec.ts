/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- service doubles; jest.fn calls are untyped */
import { ConflictException } from '@nestjs/common';
import { channelLimitReached } from '../../billing/services/channel-limit.error';
import { ChannelConnectService } from './channel-connect.service';

const WS = 'ws-1';
const USER = 'user-1';

const igAccount = {
  id: 'ig-1',
  username: 'ig_user',
  name: 'IG Name',
  profilePictureUrl: 'https://img/ig.png',
  followersCount: 5,
  mediaCount: 9,
  biography: 'bio',
};

const page = (id: string, withIg = true) => ({
  id,
  name: `Page ${id}`,
  category: 'Brand',
  pictureUrl: `https://img/${id}.png`,
  username: `page_${id}`,
  followersCount: 10,
  fanCount: 11,
  accessToken: `page-token-${id}`,
  instagramBusinessAccount: withIg ? { ...igAccount, id: `ig-${id}` } : null,
});

function make(
  over: {
    pages?: Record<string, ReturnType<typeof page> | null>;
    createChannel?: jest.Mock;
    subscribePage?: jest.Mock;
    subscribeIg?: jest.Mock;
    syncForChannel?: jest.Mock;
  } = {},
) {
  const pages = over.pages ?? { p1: page('p1'), p2: page('p2') };
  const createChannel =
    over.createChannel ??
    jest.fn(async (_ws: string, _u: string, dto: any) => ({
      id: dto.platform === 'facebook' ? 100 : 200,
      platform: dto.platform,
      platformAccountId: dto.platformAccountId,
    }));
  const channelService = { createChannel };
  const facebook = {
    getPage: jest.fn(async (id: string) => pages[id] ?? null),
    getUserPages: jest.fn(async () => Object.values(pages)),
    subscribePageToWebhooks: over.subscribePage ?? jest.fn(async () => true),
  };
  const instagram = {
    subscribeAccountToWebhooks: over.subscribeIg ?? jest.fn(async () => true),
  };
  const adAccounts = {
    syncForChannel: over.syncForChannel ?? jest.fn(async () => undefined),
  };
  const pinterest = {
    getCurrentUser: jest.fn(async () => ({
      id: 'pin-1',
      username: 'pinner',
      businessName: null,
      accountType: 'PERSONAL',
      profileImage: 'https://img/pin.png',
      followerCount: 1,
      followingCount: 2,
      monthlyViews: 3,
      websiteUrl: 'https://pin.example',
    })),
  };
  const youtube = {
    getCurrentChannel: jest.fn(async () => ({
      id: 'yt-1',
      title: 'My YT',
      customUrl: '@myyt',
      thumbnailUrl: 'https://img/yt.png',
      description: 'desc',
      subscriberCount: 1,
      videoCount: 2,
      viewCount: 3,
    })),
  };
  const linkedin = {
    getCurrentUser: jest.fn(async () => ({
      id: 'li-1',
      fullName: 'Lin Kedin',
      vanityName: 'lin',
      profilePictureUrl: 'https://img/li.png',
      email: 'lin@example.com',
      firstName: 'Lin',
      lastName: 'Kedin',
    })),
  };

  const svc = new ChannelConnectService(
    channelService as never,
    facebook as never,
    instagram as never,
    pinterest as never,
    youtube as never,
    linkedin as never,
    adAccounts as never,
  );
  return {
    svc,
    createChannel,
    facebook,
    instagram,
    adAccounts,
    pinterest,
    youtube,
    linkedin,
  };
}

const MARK = { linkId: 'link-1', email: 'client@example.com' };

describe('ChannelConnectService - LinkedIn / YouTube / Pinterest', () => {
  it('connectLinkedIn passes options through to createChannel', async () => {
    const { svc, createChannel, linkedin } = make();
    createChannel.mockResolvedValueOnce({ id: 1, platform: 'linkedin' });

    const out = await svc.connectLinkedIn(
      WS,
      USER,
      { accessToken: 'at', refreshToken: 'rt', tokenExpiresAt: '2027-01-01' },
      { connectLink: MARK },
    );

    expect(linkedin.getCurrentUser).toHaveBeenCalledWith('at');
    expect(out).toEqual({ id: 1, platform: 'linkedin' });
    expect(createChannel).toHaveBeenCalledTimes(1);
    const [ws, user, dto, opts] = createChannel.mock.calls[0];
    expect([ws, user]).toEqual([WS, USER]);
    expect(dto).toMatchObject({
      platform: 'linkedin',
      accountType: 'profile',
      platformAccountId: 'li-1',
      accountName: 'Lin Kedin',
      username: 'lin',
      accessToken: 'at',
      refreshToken: 'rt',
      tokenExpiresAt: '2027-01-01',
    });
    expect(opts).toEqual({ connectLink: MARK });
  });

  it('connectLinkedIn without options passes undefined', async () => {
    const { svc, createChannel } = make();
    await svc.connectLinkedIn(WS, USER, { accessToken: 'at' });
    expect(createChannel.mock.calls[0][3]).toBeUndefined();
  });

  it('connectYouTube passes options through to createChannel', async () => {
    const { svc, createChannel, youtube } = make();
    await svc.connectYouTube(
      WS,
      USER,
      { accessToken: 'at', refreshToken: 'rt' },
      { connectLink: MARK },
    );
    expect(youtube.getCurrentChannel).toHaveBeenCalledWith('at');
    const [, , dto, opts] = createChannel.mock.calls[0];
    expect(dto).toMatchObject({
      platform: 'youtube',
      accountType: 'channel',
      platformAccountId: 'yt-1',
      accountName: 'My YT',
      username: '@myyt',
      refreshToken: 'rt',
    });
    expect(opts).toEqual({ connectLink: MARK });
  });

  it('connectPinterest passes options through; a business account maps to business_account', async () => {
    const { svc, createChannel, pinterest } = make();
    pinterest.getCurrentUser.mockResolvedValueOnce({
      id: 'pin-2',
      username: 'biz',
      businessName: 'Biz Inc',
      accountType: 'BUSINESS',
      profileImage: null,
      followerCount: 0,
      followingCount: 0,
      monthlyViews: 0,
      websiteUrl: null,
    } as never);

    await svc.connectPinterest(
      WS,
      USER,
      { accessToken: 'at' },
      { connectLink: MARK },
    );

    const [, , dto, opts] = createChannel.mock.calls[0];
    expect(dto).toMatchObject({
      platform: 'pinterest',
      accountType: 'business_account',
      platformAccountId: 'pin-2',
      accountName: 'Biz Inc',
    });
    expect(dto.profilePictureUrl).toBeUndefined();
    expect(opts).toEqual({ connectLink: MARK });
  });

  it('a profile Pinterest account is accountType profile and uses the username', async () => {
    const { svc, createChannel } = make();
    await svc.connectPinterest(WS, USER, { accessToken: 'at' });
    expect(createChannel.mock.calls[0][2]).toMatchObject({
      accountType: 'profile',
      accountName: 'pinner',
    });
  });

  it('a createChannel failure (healthy duplicate) propagates unchanged', async () => {
    const boom = new Error('already connected');
    const { svc } = make({ createChannel: jest.fn().mockRejectedValue(boom) });
    await expect(
      svc.connectLinkedIn(WS, USER, { accessToken: 'at' }),
    ).rejects.toBe(boom);
  });
});

describe('ChannelConnectService.connectFacebookPage', () => {
  it('creates the Page and the Instagram account with the Page token, then subscribes both', async () => {
    const { svc, createChannel, facebook, instagram, adAccounts } = make();

    const out = await svc.connectFacebookPage(WS, USER, {
      userAccessToken: 'user-tok',
      pageId: 'p1',
      includeInstagram: true,
    });

    expect(facebook.getPage).toHaveBeenCalledWith('p1', 'user-tok');
    expect(createChannel).toHaveBeenCalledTimes(2);
    expect(createChannel.mock.calls[0][2]).toMatchObject({
      platform: 'facebook',
      accountType: 'page',
      platformAccountId: 'p1',
      accessToken: 'page-token-p1',
      tokenExpiresAt: undefined,
    });
    expect(createChannel.mock.calls[1][2]).toMatchObject({
      platform: 'instagram',
      accountType: 'business_account',
      platformAccountId: 'ig-p1',
      accessToken: 'page-token-p1',
      metadata: expect.objectContaining({ linkedFacebookPageId: 'p1' }),
    });
    expect(facebook.subscribePageToWebhooks).toHaveBeenCalledWith(
      'p1',
      'page-token-p1',
      expect.arrayContaining(['feed', 'messages']),
    );
    expect(instagram.subscribeAccountToWebhooks).toHaveBeenCalledWith(
      'ig-p1',
      'page-token-p1',
      ['comments', 'messages', 'messaging_postbacks', 'message_reactions'],
    );
    expect(adAccounts.syncForChannel).not.toHaveBeenCalled();
    expect(out.facebookChannel).toMatchObject({ platform: 'facebook' });
    expect(out.instagramChannel).toMatchObject({ platform: 'instagram' });
  });

  it('skips Instagram when not asked for, or when the Page has none', async () => {
    const a = make();
    const noIg = await a.svc.connectFacebookPage(WS, USER, {
      userAccessToken: 'u',
      pageId: 'p1',
      includeInstagram: false,
    });
    expect(a.createChannel).toHaveBeenCalledTimes(1);
    expect(a.instagram.subscribeAccountToWebhooks).not.toHaveBeenCalled();
    expect(noIg.instagramChannel).toBeNull();

    const b = make({ pages: { p1: page('p1', false) } });
    const none = await b.svc.connectFacebookPage(WS, USER, {
      userAccessToken: 'u',
      pageId: 'p1',
      includeInstagram: true,
    });
    expect(b.createChannel).toHaveBeenCalledTimes(1);
    expect(none.instagramChannel).toBeNull();
  });

  it('passes the link mark to BOTH channels', async () => {
    const { svc, createChannel } = make();
    await svc.connectFacebookPage(
      WS,
      USER,
      { userAccessToken: 'u', pageId: 'p1', includeInstagram: true },
      { connectLink: MARK },
    );
    expect(createChannel.mock.calls[0][3]).toEqual({ connectLink: MARK });
    expect(createChannel.mock.calls[1][3]).toEqual({ connectLink: MARK });
  });

  it('webhook failures never block the connect', async () => {
    const { svc, createChannel } = make({
      subscribePage: jest.fn().mockRejectedValue(new Error('fb webhook')),
      subscribeIg: jest.fn().mockRejectedValue(new Error('ig webhook')),
    });
    const out = await svc.connectFacebookPage(WS, USER, {
      userAccessToken: 'u',
      pageId: 'p1',
      includeInstagram: true,
    });
    expect(createChannel).toHaveBeenCalledTimes(2);
    expect(out.facebookChannel).toBeDefined();
  });

  it('intent=ads syncs ad accounts for the Facebook channel with the USER token; a failing sync never propagates', async () => {
    const syncForChannel = jest.fn().mockRejectedValue(new Error('meta down'));
    const { svc } = make({ syncForChannel });

    await expect(
      svc.connectFacebookPage(WS, USER, {
        userAccessToken: 'user-tok',
        pageId: 'p1',
        includeInstagram: false,
        intent: 'ads',
      }),
    ).resolves.toBeDefined();

    expect(syncForChannel).toHaveBeenCalledWith(WS, 100, 'user-tok');
    // let the rejected fire-and-forget promise settle without an unhandled rejection
    await new Promise((r) => setImmediate(r));
  });

  it('a page that cannot be fetched throws before creating anything', async () => {
    const { svc, createChannel } = make({ pages: { p1: null } });
    await expect(
      svc.connectFacebookPage(WS, USER, {
        userAccessToken: 'u',
        pageId: 'p1',
        includeInstagram: false,
      }),
    ).rejects.toThrow('Failed to fetch page details');
    expect(createChannel).not.toHaveBeenCalled();
  });
});

describe('ChannelConnectService.connectFacebookPages', () => {
  it('connects the pages one after another and returns every channel', async () => {
    const order: string[] = [];
    const createChannel = jest.fn(async (_w: string, _u: string, dto: any) => {
      order.push(`start:${dto.platformAccountId}`);
      await new Promise((r) => setImmediate(r));
      order.push(`end:${dto.platformAccountId}`);
      return { id: order.length, platform: dto.platform };
    });
    const { svc } = make({ createChannel });

    const out = await svc.connectFacebookPages(
      WS,
      USER,
      {
        userAccessToken: 'u',
        pageIds: ['p1', 'p2'],
        includeInstagram: true,
      },
      { connectLink: MARK },
    );

    expect(out.channels.map((c) => c.platform)).toEqual([
      'facebook',
      'instagram',
      'facebook',
      'instagram',
    ]);
    // Sequential: a page's channels finish before the next page starts.
    expect(order).toEqual([
      'start:p1',
      'end:p1',
      'start:ig-p1',
      'end:ig-p1',
      'start:p2',
      'end:p2',
      'start:ig-p2',
      'end:ig-p2',
    ]);
  });

  it('stops at CHANNEL_LIMIT_REACHED and rethrows; earlier pages stay connected', async () => {
    const limit = channelLimitReached(3, 3);
    const createChannel = jest
      .fn()
      .mockResolvedValueOnce({ id: 1, platform: 'facebook' })
      .mockRejectedValueOnce(limit);
    const { svc, facebook } = make({
      createChannel,
      pages: { p1: page('p1', false), p2: page('p2', false), p3: page('p3') },
    });

    await expect(
      svc.connectFacebookPages(WS, USER, {
        userAccessToken: 'u',
        pageIds: ['p1', 'p2', 'p3'],
        includeInstagram: false,
      }),
    ).rejects.toBe(limit);

    expect(createChannel).toHaveBeenCalledTimes(2);
    expect(facebook.getPage).not.toHaveBeenCalledWith('p3', 'u');
  });

  it('an empty list connects nothing', async () => {
    const { svc, createChannel } = make();
    const out = await svc.connectFacebookPages(WS, USER, {
      userAccessToken: 'u',
      pageIds: [],
      includeInstagram: true,
    });
    expect(out.channels).toEqual([]);
    expect(createChannel).not.toHaveBeenCalled();
  });
});

describe('ChannelConnectService.listFacebookPages', () => {
  it('returns the shape POST /channels/facebook/pages returns today', async () => {
    const { svc, facebook } = make({
      pages: { p1: page('p1'), p2: page('p2', false) },
    });
    const out = await svc.listFacebookPages('user-tok');

    expect(facebook.getUserPages).toHaveBeenCalledWith('user-tok');
    expect(out).toEqual([
      {
        id: 'p1',
        name: 'Page p1',
        category: 'Brand',
        pictureUrl: 'https://img/p1.png',
        username: 'page_p1',
        followersCount: 10,
        fanCount: 11,
        hasInstagram: true,
        instagramAccount: {
          id: 'ig-p1',
          username: 'ig_user',
          name: 'IG Name',
          profilePictureUrl: 'https://img/ig.png',
          followersCount: 5,
        },
      },
      expect.objectContaining({
        id: 'p2',
        hasInstagram: false,
        instagramAccount: null,
      }),
    ]);
    // Never leaks the Page Access Token.
    expect(JSON.stringify(out)).not.toContain('page-token');
  });
});

describe('ChannelConnectService - an Instagram step that fails after the Page channel exists', () => {
  /** FB insert succeeds, the IG insert fails with `igError`. */
  function failingIg(igError: unknown) {
    return jest.fn(async (_ws: string, _u: string, dto: any) => {
      if (dto.platform === 'instagram') throw igError;
      return { id: 100, platform: 'facebook', accountName: 'Page p1' };
    });
  }

  it.each([
    ['a healthy duplicate', new ConflictException('already connected')],
    ['the channel limit', channelLimitReached(3, 3)],
    ['any other error', new Error('graph down')],
  ])(
    'connectFacebookPageSettled (%s): the Page channel is returned, its webhooks still subscribed, the IG error handed back',
    async (_label, igError) => {
      const { svc, facebook, instagram } = make({
        createChannel: failingIg(igError),
      });
      const out = await svc.connectFacebookPageSettled(WS, USER, {
        userAccessToken: 'u',
        pageId: 'p1',
        includeInstagram: true,
      });
      expect(out.facebookChannel).toMatchObject({ id: 100 });
      expect(out.instagramChannel).toBeNull();
      expect(out.instagramError).toBe(igError);
      expect(facebook.subscribePageToWebhooks).toHaveBeenCalledWith(
        'p1',
        'page-token-p1',
        expect.arrayContaining(['feed', 'messages']),
      );
      expect(instagram.subscribeAccountToWebhooks).not.toHaveBeenCalled();
    },
  );

  it('connectFacebookPageSettled without an IG failure has instagramError null', async () => {
    const { svc } = make();
    const out = await svc.connectFacebookPageSettled(WS, USER, {
      userAccessToken: 'u',
      pageId: 'p1',
      includeInstagram: true,
    });
    expect(out.instagramError).toBeNull();
    expect(out.instagramChannel).toMatchObject({ platform: 'instagram' });
  });

  it('the team connectFacebookPage still rejects with the IG error, but only after the Page webhooks are subscribed', async () => {
    const limit = channelLimitReached(3, 3);
    const { svc, facebook } = make({ createChannel: failingIg(limit) });
    await expect(
      svc.connectFacebookPage(WS, USER, {
        userAccessToken: 'u',
        pageId: 'p1',
        includeInstagram: true,
      }),
    ).rejects.toBe(limit);
    expect(facebook.subscribePageToWebhooks).toHaveBeenCalledTimes(1);
  });

  it('a Page-channel failure still throws before any webhook (nothing was created)', async () => {
    const dup = new ConflictException('dup');
    const { svc, facebook } = make({
      createChannel: jest.fn(async () => {
        throw dup;
      }),
    });
    await expect(
      svc.connectFacebookPageSettled(WS, USER, {
        userAccessToken: 'u',
        pageId: 'p1',
        includeInstagram: true,
      }),
    ).rejects.toBe(dup);
    expect(facebook.subscribePageToWebhooks).not.toHaveBeenCalled();
  });
});
