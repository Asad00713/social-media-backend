import { Logger } from '@nestjs/common';
import { AppLinks } from '../../email/links/app-links';
import { RefreshTokenExpiryScheduler } from './refresh-token-expiry.scheduler';
import { ChannelHealthNotifier } from '../services/channel-health-notifier.service';

const DAY = 24 * 60 * 60 * 1000;
const WS = 'ws-1';
const INSTAGRAM_TTL_DAYS = 60;
const OWNER = { id: 'u-owner', email: 'owner@x.test', name: 'Owner' };

/** A channel (instagram: 60 day refresh token) with `daysLeft` days to run. */
function channel(id: number, daysLeft: number, platform = 'instagram') {
  return {
    id,
    platform,
    accountName: `acct-${id}`,
    accountType: 'business_account',
    workspaceId: WS,
    // half a day over, so floor() lands on daysLeft
    refreshTokenIssuedAt: new Date(
      Date.now() - (INSTAGRAM_TTL_DAYS - daysLeft - 0.5) * DAY,
    ),
  };
}

function setup(rows: ReturnType<typeof channel>[]) {
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  };
  const notify = {
    notify: jest
      .fn<Promise<void>, [{ email: { idempotencyKey: string } }]>()
      .mockResolvedValue(undefined),
  };
  const recipients = {
    admins: jest.fn().mockResolvedValue([OWNER]),
    workspace: jest.fn().mockResolvedValue({ id: WS, timezone: 'UTC' }),
  };
  const taken = new Set<string>();
  const once = {
    claim: jest.fn((k: string) => {
      if (taken.has(k)) return Promise.resolve(false);
      taken.add(k);
      return Promise.resolve(true);
    }),
  };
  const countRow = [{ n: 2, next: new Date(Date.now() + DAY) }];
  const notifierDb = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(countRow) }),
    }),
  };
  const notifier = new ChannelHealthNotifier(
    notifierDb as never,
    notify as never,
    recipients as never,
    once as never,
    new AppLinks({ get: () => undefined } as never),
    { tokenExpired: jest.fn() } as never,
  );
  const scheduler = new RefreshTokenExpiryScheduler(db as never, notifier);
  return { scheduler, notify };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const keyOf = (c: [{ email: { idempotencyKey: string } }]) =>
  c[0].email.idempotencyKey;

describe('RefreshTokenExpiryScheduler reconnect emails', () => {
  it('sends stage 7 at 6 days left and stage 1 at 1 day left', async () => {
    const six = setup([channel(1, 6)]);
    await six.scheduler.checkRefreshTokenExpiry();
    expect(six.notify.notify).toHaveBeenCalledTimes(1);
    expect(keyOf(six.notify.notify.mock.calls[0])).toMatch(/\.7\.u-owner$/);

    const one = setup([channel(2, 1)]);
    await one.scheduler.checkRefreshTokenExpiry();
    expect(one.notify.notify).toHaveBeenCalledTimes(1);
    expect(keyOf(one.notify.notify.mock.calls[0])).toMatch(/\.1\.u-owner$/);
  });

  it('warns a week ahead, not three days', async () => {
    const { scheduler, notify } = setup([channel(1, 7)]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('never mails a stage twice across daily runs', async () => {
    const { scheduler, notify } = setup([channel(1, 5)]);
    await scheduler.checkRefreshTokenExpiry();
    await scheduler.checkRefreshTokenExpiry();
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('leaves channels with more than a week, and non-expiring ones, alone', async () => {
    const { scheduler, notify } = setup([
      channel(1, 20),
      channel(2, 3, 'bluesky'),
    ]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).not.toHaveBeenCalled();
  });
});
