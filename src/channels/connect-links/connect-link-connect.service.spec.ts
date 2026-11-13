import { ConflictException, HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { channelLimitReached } from '../../billing/services/channel-limit.error';
import type { ChannelConnectService } from '../services/channel-connect.service';
import type {
  ConnectLinkAccessService,
  ResolvedConnectLink,
} from './connect-link-access.service';
import { ConnectLinkConnectService } from './connect-link-connect.service';
import { ConnectLinkFacebookConnectBody } from './dto/connect-link.dto';
import {
  FacebookSelectionStore,
  FB_SELECTION_TTL_SECONDS,
  fbSelectionKey,
  type SelectionRedis,
} from './facebook-selection.store';
import { connectLinkError } from './lib/connect-link-errors';

const WS = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const OTHER_LINK = '55555555-5555-4555-8555-555555555555';
const USER_TOKEN = 'FB-USER-TOKEN-SECRET';
const RAW = 'raw-link-token';
const MARK = { connectLink: { linkId: LINK, email: 'client@example.com' } };

function resolved(
  linkId = LINK,
  networks = ['facebook', 'instagram'],
): ResolvedConnectLink {
  return {
    link: {
      id: linkId,
      workspaceId: WS,
      createdByUserId: SENDER,
      email: 'client@example.com',
      networks,
    } as unknown as ResolvedConnectLink['link'],
    workspace: { id: WS, name: 'Acme Agency' },
    sender: { id: SENDER, name: 'Sam', email: 'sam@agency.test' },
  };
}

function fakeRedis() {
  const store = new Map<string, string>();
  const get = jest.fn((k: string) => Promise.resolve(store.get(k) ?? null));
  const ttl = new Map<string, number>();
  const redis: SelectionRedis = {
    set: jest.fn((k: string, v: string, _m: 'EX', s: number) => {
      store.set(k, v);
      ttl.set(k, s);
      return Promise.resolve('OK');
    }),
    get,
    del: jest.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
  };
  return { redis, store, ttl, get };
}

function page(id: string, withIg = true) {
  return {
    facebookChannel: {
      id: Number(id),
      platform: 'facebook',
      accountName: `Page ${id}`,
    },
    instagramChannel: withIg
      ? { id: Number(id) + 100, platform: 'instagram', accountName: `IG ${id}` }
      : null,
  };
}

function setup(opts: { networks?: string[]; resolve?: jest.Mock } = {}) {
  const { redis, store, ttl, get } = fakeRedis();
  const selections = new FacebookSelectionStore(redis);
  const resolve =
    opts.resolve ?? jest.fn().mockResolvedValue(resolved(LINK, opts.networks));
  const access = { resolve } as unknown as ConnectLinkAccessService;
  const connectFacebookPage = jest.fn(
    (
      _ws: string,
      _u: string,
      input: { pageId: string; includeInstagram?: boolean },
    ) => Promise.resolve(page(input.pageId, !!input.includeInstagram)),
  );
  const listFacebookPages = jest
    .fn()
    .mockResolvedValue([{ id: '1', name: 'Page 1', hasInstagram: true }]);
  const channelConnect = {
    connectFacebookPage,
    listFacebookPages,
  } as unknown as ChannelConnectService;
  const channelConnected = jest.fn().mockResolvedValue(undefined);
  const service = new ConnectLinkConnectService(
    channelConnect,
    selections,
    { channelConnected } as never,
    access,
  );
  return {
    service,
    selections,
    store,
    ttl,
    redisGet: get,
    resolve,
    connectFacebookPage,
    listFacebookPages,
    channelConnected,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return ((e as HttpException).getResponse() as { code?: string }).code;
  }
  return undefined;
}

describe('ConnectLinkConnectService - public Facebook Pages', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('a selection lives 15 minutes, keyed connect-link:fb-selection:<id>, token encrypted', async () => {
    const t = setup();
    const id = await t.selections.create(LINK, USER_TOKEN);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(t.ttl.get(fbSelectionKey(id))).toBe(FB_SELECTION_TTL_SECONDS);
    expect(FB_SELECTION_TTL_SECONDS).toBe(900);
    expect(t.store.get(fbSelectionKey(id))).not.toContain(USER_TOKEN);
  });

  describe('facebookPages (GET)', () => {
    it('lists the Pages with the parked user token', async () => {
      const t = setup();
      const id = await t.selections.create(LINK, USER_TOKEN);
      await expect(t.service.facebookPages(RAW, id)).resolves.toEqual([
        { id: '1', name: 'Page 1', hasInstagram: true },
      ]);
      expect(t.resolve).toHaveBeenCalledWith(RAW);
      expect(t.listFacebookPages).toHaveBeenCalledWith(USER_TOKEN);
    });

    it('does not consume the selection (the page may reload)', async () => {
      const t = setup();
      const id = await t.selections.create(LINK, USER_TOKEN);
      await t.service.facebookPages(RAW, id);
      await t.service.facebookPages(RAW, id);
      expect(t.store.has(fbSelectionKey(id))).toBe(true);
      await expect(
        t.service.connectFacebook(RAW, {
          selection: id,
          pageIds: ['1'],
          includeInstagram: false,
        }),
      ).resolves.toBeDefined();
    });
  });

  it('selection of another link → SELECTION_EXPIRED', async () => {
    const t = setup();
    const id = await t.selections.create(OTHER_LINK, USER_TOKEN);
    expect(await codeOf(t.service.facebookPages(RAW, id))).toBe(
      'SELECTION_EXPIRED',
    );
    expect(
      await codeOf(
        t.service.connectFacebook(RAW, {
          selection: id,
          pageIds: ['1'],
          includeInstagram: true,
        }),
      ),
    ).toBe('SELECTION_EXPIRED');
    // another link's visitor cannot burn it
    expect(t.store.has(fbSelectionKey(id))).toBe(true);
    expect(t.listFacebookPages).not.toHaveBeenCalled();
    expect(t.connectFacebookPage).not.toHaveBeenCalled();
  });

  it('missing/expired selection → SELECTION_EXPIRED', async () => {
    const t = setup();
    const unknown = 'A'.repeat(32);
    expect(await codeOf(t.service.facebookPages(RAW, unknown))).toBe(
      'SELECTION_EXPIRED',
    );
    // a malformed id never reaches Redis
    expect(await codeOf(t.service.facebookPages(RAW, '../../x'))).toBe(
      'SELECTION_EXPIRED',
    );
    expect(await codeOf(t.service.facebookPages(RAW, ''))).toBe(
      'SELECTION_EXPIRED',
    );
    expect(t.redisGet).toHaveBeenCalledTimes(1);
    // the TTL ran out: the key is simply gone
    const id = await t.selections.create(LINK, USER_TOKEN);
    t.store.delete(fbSelectionKey(id));
    expect(
      await codeOf(
        t.service.connectFacebook(RAW, {
          selection: id,
          pageIds: ['1'],
          includeInstagram: false,
        }),
      ),
    ).toBe('SELECTION_EXPIRED');
  });

  it('selection is single use (second connect → SELECTION_EXPIRED)', async () => {
    const t = setup();
    const id = await t.selections.create(LINK, USER_TOKEN);
    const body = { selection: id, pageIds: ['1'], includeInstagram: false };
    await t.service.connectFacebook(RAW, body);
    expect(t.store.has(fbSelectionKey(id))).toBe(false);
    expect(await codeOf(t.service.connectFacebook(RAW, body))).toBe(
      'SELECTION_EXPIRED',
    );
    expect(await codeOf(t.service.facebookPages(RAW, id))).toBe(
      'SELECTION_EXPIRED',
    );
    expect(t.connectFacebookPage).toHaveBeenCalledTimes(1);
  });

  it('of two concurrent connects only one wins', async () => {
    const t = setup();
    const id = await t.selections.create(LINK, USER_TOKEN);
    const body = { selection: id, pageIds: ['1'], includeInstagram: false };
    const results = await Promise.allSettled([
      t.service.connectFacebook(RAW, body),
      t.service.connectFacebook(RAW, body),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.connectFacebookPage).toHaveBeenCalledTimes(1);
  });

  it('connect marks every page channel with the link and notifies the sender once per channel', async () => {
    const t = setup();
    const id = await t.selections.create(LINK, USER_TOKEN);
    const result = await t.service.connectFacebook(RAW, {
      selection: id,
      pageIds: ['1', '2'],
      includeInstagram: true,
    });
    expect(result).toEqual({
      channels: [
        { platform: 'facebook', channelId: 1, accountName: 'Page 1' },
        { platform: 'instagram', channelId: 101, accountName: 'IG 1' },
        { platform: 'facebook', channelId: 2, accountName: 'Page 2' },
        { platform: 'instagram', channelId: 102, accountName: 'IG 2' },
      ],
      skipped: [],
    });
    // one page per call, as the sender, with the link mark, intent connect
    expect(t.connectFacebookPage).toHaveBeenCalledTimes(2);
    for (const pageId of ['1', '2']) {
      expect(t.connectFacebookPage).toHaveBeenCalledWith(
        WS,
        SENDER,
        {
          userAccessToken: USER_TOKEN,
          pageId,
          includeInstagram: true,
          intent: 'connect',
        },
        MARK,
      );
    }
    expect(t.channelConnected).toHaveBeenCalledTimes(4);
    expect(t.channelConnected).toHaveBeenCalledWith(
      SENDER,
      'Facebook',
      'Page 1',
      WS,
    );
    expect(t.channelConnected).toHaveBeenCalledWith(
      SENDER,
      'Instagram',
      'IG 1',
      WS,
    );
    expect(t.channelConnected).toHaveBeenCalledWith(
      SENDER,
      'Facebook',
      'Page 2',
      WS,
    );
    expect(t.channelConnected).toHaveBeenCalledWith(
      SENDER,
      'Instagram',
      'IG 2',
      WS,
    );
  });

  it('Instagram via a Page only when the link offers Instagram', async () => {
    const t = setup({ networks: ['facebook'] });
    const id = await t.selections.create(LINK, USER_TOKEN);
    const result = await t.service.connectFacebook(RAW, {
      selection: id,
      pageIds: ['1'],
      includeInstagram: true,
    });
    expect(t.connectFacebookPage.mock.calls[0][2]).toMatchObject({
      includeInstagram: false,
    });
    expect(result.channels.map((c) => c.platform)).toEqual(['facebook']);
  });

  it('a page already connected is skipped as ALREADY_CONNECTED and the rest still connect', async () => {
    const t = setup();
    t.connectFacebookPage.mockImplementationOnce(() =>
      Promise.reject(new ConflictException('already connected')),
    );
    const id = await t.selections.create(LINK, USER_TOKEN);
    const result = await t.service.connectFacebook(RAW, {
      selection: id,
      pageIds: ['1', '2'],
      includeInstagram: false,
    });
    expect(result).toEqual({
      channels: [{ platform: 'facebook', channelId: 2, accountName: 'Page 2' }],
      skipped: [{ pageId: '1', code: 'ALREADY_CONNECTED' }],
    });
    expect(t.channelConnected).toHaveBeenCalledTimes(1);
  });

  it('every page already connected → 409 ALREADY_CONNECTED', async () => {
    const t = setup();
    t.connectFacebookPage.mockRejectedValue(new ConflictException('dup'));
    const id = await t.selections.create(LINK, USER_TOKEN);
    const p = t.service.connectFacebook(RAW, {
      selection: id,
      pageIds: ['1', '2'],
      includeInstagram: false,
    });
    await expect(p).rejects.toMatchObject({ status: 409 });
    expect(
      await codeOf(
        (async () => {
          const again = setup();
          again.connectFacebookPage.mockRejectedValue(
            new ConflictException('dup'),
          );
          const sel = await again.selections.create(LINK, USER_TOKEN);
          return again.service.connectFacebook(RAW, {
            selection: sel,
            pageIds: ['1'],
            includeInstagram: false,
          });
        })(),
      ),
    ).toBe('ALREADY_CONNECTED');
  });

  it('CHANNEL_LIMIT_REACHED stops the loop; pages before it stay connected', async () => {
    const t = setup();
    t.connectFacebookPage
      .mockImplementationOnce(() => Promise.resolve(page('1', false)))
      .mockImplementationOnce(() => Promise.reject(channelLimitReached(3, 3)));
    const id = await t.selections.create(LINK, USER_TOKEN);
    expect(
      await codeOf(
        t.service.connectFacebook(RAW, {
          selection: id,
          pageIds: ['1', '2', '3'],
          includeInstagram: false,
        }),
      ),
    ).toBe('CHANNEL_LIMIT_REACHED');
    expect(t.connectFacebookPage).toHaveBeenCalledTimes(2);
    expect(t.channelConnected).toHaveBeenCalledTimes(1);
  });

  it('a dead link refuses before the selection is touched', async () => {
    const t = setup({
      resolve: jest
        .fn()
        .mockRejectedValue(connectLinkError('LINK_REVOKED', 'cancelled')),
    });
    const id = await t.selections.create(LINK, USER_TOKEN);
    expect(
      await codeOf(
        t.service.connectFacebook(RAW, {
          selection: id,
          pageIds: ['1'],
          includeInstagram: false,
        }),
      ),
    ).toBe('LINK_REVOKED');
    expect(t.store.has(fbSelectionKey(id))).toBe(true);
  });

  it('a link that does not offer Facebook → NETWORK_NOT_OFFERED', async () => {
    const t = setup({ networks: ['instagram'] });
    const id = await t.selections.create(LINK, USER_TOKEN);
    expect(await codeOf(t.service.facebookPages(RAW, id))).toBe(
      'NETWORK_NOT_OFFERED',
    );
  });

  it('a failing notification does not fail the connect', async () => {
    const t = setup();
    t.channelConnected.mockRejectedValue(new Error('socket down'));
    const id = await t.selections.create(LINK, USER_TOKEN);
    await expect(
      t.service.connectFacebook(RAW, {
        selection: id,
        pageIds: ['1'],
        includeInstagram: false,
      }),
    ).resolves.toMatchObject({ channels: [{ channelId: 1 }] });
  });
});

describe('ConnectLinkFacebookConnectBody', () => {
  async function errorsOf(body: unknown) {
    return validate(plainToInstance(ConnectLinkFacebookConnectBody, body));
  }

  it('accepts 1-25 page ids, a selection and includeInstagram', async () => {
    expect(
      await errorsOf({
        selection: 's',
        pageIds: ['1'],
        includeInstagram: false,
      }),
    ).toHaveLength(0);
  });

  it('refuses no pages, more than 25, a missing selection or flag', async () => {
    expect(
      await errorsOf({ selection: 's', pageIds: [], includeInstagram: false }),
    ).not.toHaveLength(0);
    expect(
      await errorsOf({
        selection: 's',
        pageIds: Array.from({ length: 26 }, (_, i) => String(i)),
        includeInstagram: false,
      }),
    ).not.toHaveLength(0);
    expect(
      await errorsOf({ pageIds: ['1'], includeInstagram: false }),
    ).not.toHaveLength(0);
    expect(await errorsOf({ selection: 's', pageIds: ['1'] })).not.toHaveLength(
      0,
    );
  });
});
