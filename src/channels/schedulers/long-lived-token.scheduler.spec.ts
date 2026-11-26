import { Logger } from '@nestjs/common';
import { LongLivedTokenScheduler } from './long-lived-token.scheduler';

/**
 * The renewal that keeps Instagram and Threads alive.
 *
 * These platforms have no OAuth2 refresh token, so all three existing
 * mechanisms skipped them and their 60-day token simply lapsed — no renewal
 * and no warning. This scheduler is the renewal.
 */

jest.mock('../../common/utils/encryption.util', () => ({
  // Identity crypto: the test cares which token was SENT and STORED, and real
  // encryption would only hide that behind ciphertext.
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => String(v).replace(/^enc\((.*)\)$/, '$1'),
}));

const DAY = 24 * 60 * 60 * 1000;
const WS = 'ws-1';

interface Row {
  id: number;
  platform: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  updatedAt: Date | null;
  accountName?: string;
  accountType?: string;
  username?: string | null;
  workspaceId?: string;
  refreshToken?: string | null;
  refreshTokenIssuedAt?: Date | null;
}

/** A long-lived channel whose token expires in `daysLeft` days. */
function row(id: number, daysLeft: number, platform = 'instagram'): Row {
  return {
    id,
    platform,
    accessToken: `enc(tok-${id})`,
    tokenExpiresAt: new Date(Date.now() + daysLeft * DAY),
    // Connected long ago, so Meta's 24h minimum age is satisfied.
    updatedAt: new Date(Date.now() - 30 * DAY),
    accountName: `acct-${id}`,
    accountType: 'business_account',
    username: `user-${id}`,
    workspaceId: WS,
    refreshToken: null,
    refreshTokenIssuedAt: null,
  };
}

function setup(rows: Row[]) {
  const updates: { id: unknown; values: Record<string, unknown> }[] = [];

  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push({ id: 'captured', values });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  const instagram = {
    refreshLongLivedToken: jest
      .fn()
      .mockResolvedValue({ accessToken: 'ig-new', expiresIn: 5_183_944 }),
  };
  const threads = {
    refreshLongLivedToken: jest
      .fn()
      .mockResolvedValue({ accessToken: 'th-new', expiresIn: 5_183_944 }),
  };
  const health = { markExpired: jest.fn().mockResolvedValue(undefined) };

  const scheduler = new LongLivedTokenScheduler(
    db as never,
    instagram as never,
    threads as never,
    health as never,
  );

  return { scheduler, instagram, threads, health, updates };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('LongLivedTokenScheduler', () => {
  it('renews an Instagram token that is close to expiry', async () => {
    const { scheduler, instagram, updates } = setup([row(1, 5)]);

    await scheduler.renewLongLivedTokens();

    // The DECRYPTED token goes to Meta — sending ciphertext would be rejected.
    expect(instagram.refreshLongLivedToken).toHaveBeenCalledWith('tok-1');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      accessToken: 'enc(ig-new)',
      connectionStatus: 'connected',
      lastError: null,
    });
  });

  it('stores the expiry Meta returned, not a guess', async () => {
    const { scheduler, updates } = setup([row(1, 5)]);

    await scheduler.renewLongLivedTokens();

    const stored = updates[0].values.tokenExpiresAt as Date;
    const expected = Date.now() + 5_183_944 * 1000;
    // Within a minute: the scheduler reads its own clock.
    expect(Math.abs(stored.getTime() - expected)).toBeLessThan(60_000);
    // And it must genuinely be ~60 days out, or the renewal achieved nothing.
    expect(stored.getTime() - Date.now()).toBeGreaterThan(55 * DAY);
  });

  it('routes a Threads channel to the Threads API, not Instagram’s', async () => {
    // Different hosts and different grant_type values; crossing them fails.
    const { scheduler, instagram, threads } = setup([row(2, 3, 'threads')]);

    await scheduler.renewLongLivedTokens();

    expect(threads.refreshLongLivedToken).toHaveBeenCalledWith('tok-2');
    expect(instagram.refreshLongLivedToken).not.toHaveBeenCalled();
  });

  it('leaves a token alone while it still has plenty of life', async () => {
    // Renewing every day would burn API calls and rewrite the row for
    // nothing. 40 days out is the healthy steady state.
    const { scheduler, instagram, threads, updates } = setup([row(1, 40)]);

    await scheduler.renewLongLivedTokens();

    expect(instagram.refreshLongLivedToken).not.toHaveBeenCalled();
    expect(threads.refreshLongLivedToken).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('does not call Meta for an already-expired token, and flags a reconnect', async () => {
    // Meta refuses to renew a lapsed token, so the call would be wasted and
    // the real remedy is the user reconnecting. That has to be said out loud
    // rather than retried silently every day.
    const { scheduler, instagram, health } = setup([row(1, -2)]);

    await scheduler.renewLongLivedTokens();

    expect(instagram.refreshLongLivedToken).not.toHaveBeenCalled();
    const saysReconnect: unknown = expect.objectContaining({
      lastError: expect.stringContaining('reconnect') as unknown,
    });
    expect(health.markExpired).toHaveBeenCalledWith(1, saysReconnect);
  });

  it('does NOT mark a channel expired when Meta merely errors', async () => {
    // The token is still valid for days — the renewal window opens early on
    // purpose. Flipping the status on a transient failure would stop a
    // working channel from publishing and email the owner for nothing.
    const { scheduler, instagram, health, updates } = setup([row(1, 5)]);
    instagram.refreshLongLivedToken.mockRejectedValue(new Error('500 oops'));

    await scheduler.renewLongLivedTokens();

    expect(health.markExpired).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('keeps going after one channel fails', async () => {
    // One bad channel must not strand every later one; a thrown error inside
    // the loop would leave the rest unrenewed until tomorrow.
    const { scheduler, instagram, updates } = setup([row(1, 5), row(2, 5)]);
    instagram.refreshLongLivedToken
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ accessToken: 'ig-2', expiresIn: 5_183_944 });

    await scheduler.renewLongLivedTokens();

    expect(instagram.refreshLongLivedToken).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1);
  });

  it('respects Meta’s 24-hour minimum token age', async () => {
    // A channel connected an hour ago cannot be renewed; Meta rejects it.
    const fresh = { ...row(1, 5), updatedAt: new Date(Date.now() - 3600_000) };
    const { scheduler, instagram } = setup([fresh]);

    await scheduler.renewLongLivedTokens();

    expect(instagram.refreshLongLivedToken).not.toHaveBeenCalled();
  });

  it('skips a channel with no recorded expiry', async () => {
    // Shares a non-expiring Facebook Page token: nothing to renew.
    const { scheduler, instagram } = setup([
      { ...row(1, 5), tokenExpiresAt: null },
    ]);

    await scheduler.renewLongLivedTokens();

    expect(instagram.refreshLongLivedToken).not.toHaveBeenCalled();
  });
});
