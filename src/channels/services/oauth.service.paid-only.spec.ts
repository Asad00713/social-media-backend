/* eslint-disable @typescript-eslint/require-await -- service doubles */
import { ForbiddenException } from '@nestjs/common';

const inserted: Array<Record<string, unknown>> = [];

jest.mock('../../drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  },
}));

import { OAuthService } from './oauth.service';
import { AccountChannelsService } from '../../billing/services/account-channels.service';

/**
 * Every OAuth start - the team initiate, the reconnect route and a connect
 * link's public start - goes through OAuthService.initiateOAuth. A free
 * workspace starting a NEW X connect is refused there, before a state is
 * stored or X's consent screen is shown. (The callback's write refuses it
 * again: see channel.service.paid-only.spec.ts.)
 */
function make(opts: {
  subscription: Record<string, unknown> | null;
  hasXChannel: boolean;
}) {
  const accountChannels = new AccountChannelsService({
    findByUserId: jest.fn(async () => opts.subscription),
    getOwnerId: jest.fn(async () => 'owner-1'),
  } as never);
  const has = jest
    .spyOn(accountChannels, 'hasChannelOn')
    .mockResolvedValue(opts.hasXChannel);
  const oauth = new OAuthService(accountChannels);
  jest
    .spyOn(
      oauth as unknown as { getPlatformCredentials: () => Promise<unknown> },
      'getPlatformCredentials',
    )
    .mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' });
  return { oauth, has };
}

const FREE = { id: 1, planCode: 'FREE', status: 'active' };
const PRO = { id: 1, planCode: 'PRO', status: 'active' };

beforeEach(() => {
  inserted.length = 0;
});

describe('OAuthService.initiateOAuth - X is paid-only', () => {
  it('refuses a new X connect on a FREE workspace, storing no state', async () => {
    const { oauth } = make({ subscription: FREE, hasXChannel: false });
    const err = await oauth
      .initiateOAuth('ws', 'u1', { platform: 'twitter' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'PLAN_UPGRADE_REQUIRED',
      feature: 'x',
    });
    expect(inserted).toHaveLength(0);
  });

  it('starts an X connect on a paid workspace', async () => {
    const { oauth } = make({ subscription: PRO, hasXChannel: false });
    const out = await oauth.initiateOAuth('ws', 'u1', { platform: 'twitter' });
    expect(out.authorizationUrl).toContain('state=');
    expect(inserted).toHaveLength(1);
  });

  it('lets a FREE workspace that holds an X channel start (reconnect)', async () => {
    const { oauth, has } = make({ subscription: FREE, hasXChannel: true });
    await oauth.initiateOAuth('ws', 'u1', {
      platform: 'twitter',
      additionalData: { reconnectChannelId: '7' },
    });
    expect(has).toHaveBeenCalledWith('ws', 'twitter');
    expect(inserted).toHaveLength(1);
  });

  it('leaves other platforms on a FREE workspace unaffected', async () => {
    const { oauth } = make({ subscription: FREE, hasXChannel: false });
    await oauth.initiateOAuth('ws', 'u1', { platform: 'linkedin' });
    expect(inserted).toHaveLength(1);
  });
});
