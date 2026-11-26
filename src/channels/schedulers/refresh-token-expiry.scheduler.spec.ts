import { Logger } from '@nestjs/common';
import { AppLinks } from '../../email/links/app-links';
import { RefreshTokenExpiryScheduler } from './refresh-token-expiry.scheduler';
import { ChannelHealthNotifier } from '../services/channel-health-notifier.service';

const DAY = 24 * 60 * 60 * 1000;
const WS = 'ws-1';
/**
 * LinkedIn's refresh-token TTL, also 60 days.
 *
 * This fixture used to say `instagram`, which cannot hold this shape: an
 * Instagram channel has NO refresh token (`supportsRefreshToken: false`), so
 * a row with `refreshTokenIssuedAt` and no `tokenExpiresAt` never occurs in
 * production. The tests still passed, because nothing looked at the platform
 * — they were asserting the TTL maths against an impossible channel. LinkedIn
 * is a platform that really does have a 60-day refresh-token TTL, so the
 * numbers below are unchanged and now describe something real.
 */
const REFRESH_TTL_DAYS = 60;
const OWNER = { id: 'u-owner', email: 'owner@x.test', name: 'Owner' };

/** A channel with a refresh-token grant that has `daysLeft` days to run. */
function channel(id: number, daysLeft: number, platform = 'linkedin') {
  return {
    id,
    platform,
    accountName: `acct-${id}`,
    accountType: 'profile',
    workspaceId: WS,
    // half a day over, so floor() lands on daysLeft
    refreshTokenIssuedAt: new Date(
      Date.now() - (REFRESH_TTL_DAYS - daysLeft - 0.5) * DAY,
    ),
  };
}

/**
 * A long-lived Meta channel: an access token with its own expiry and NO
 * refresh token. This is the shape Instagram and Threads actually store, and
 * the one this cron used to filter out entirely.
 */
function longLivedChannel(id: number, daysLeft: number, platform = 'instagram') {
  return {
    id,
    platform,
    accountName: `acct-${id}`,
    accountType: platform === 'threads' ? 'profile' : 'business_account',
    workspaceId: WS,
    refreshTokenIssuedAt: null,
    tokenExpiresAt: new Date(Date.now() + (daysLeft + 0.5) * DAY),
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

  it('warns a long-lived Instagram channel, which it used to skip entirely', async () => {
    // The gap. Instagram stores no refresh token, so the old query —
    // `refresh_token IS NOT NULL AND refresh_token_issued_at IS NOT NULL` —
    // excluded it. Its 60-day token could lapse with no renewal and no
    // warning: the channel just stopped publishing.
    const { scheduler, notify } = setup([longLivedChannel(1, 5)]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('warns a long-lived Threads channel too', async () => {
    const { scheduler, notify } = setup([longLivedChannel(2, 2, 'threads')]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('leaves a long-lived channel alone while it has plenty of life', async () => {
    // The daily renewal keeps these ~60 days out, so the normal state is
    // silence. Warning earlier would fire on every healthy channel.
    const { scheduler, notify } = setup([longLivedChannel(3, 40)]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('does not warn a long-lived channel that records no expiry', async () => {
    // The Instagram channel created beside a Facebook Page shares the Page's
    // NON-expiring token and stores no expiry. Treating null as "overdue"
    // would email the owner daily about a token that never dies.
    const { scheduler, notify } = setup([
      { ...longLivedChannel(4, 1), tokenExpiresAt: null },
    ]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).not.toHaveBeenCalled();
  });
});
