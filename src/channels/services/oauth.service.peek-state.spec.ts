import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const where = jest.fn<void, [unknown]>();
let rows: Array<{ additionalData: unknown }> = [];

jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          where(cond);
          return { limit: () => Promise.resolve(rows) };
        },
      }),
    }),
    update: jest.fn(),
  },
}));

import { LINK_STATE_PEEK_GRACE_MS, OAuthService } from './oauth.service';

/**
 * peekState must stay a bounded read: it decides where a callback error is
 * shown for a link visitor, and the link page URL it leads to carries the raw
 * link token. A visitor may sit on the network's login page longer than the
 * state's 15 minutes, so a state keeps answering for a grace period past its
 * expiry (LINK_STATE_PEEK_GRACE_MS, 1 hour) - and no longer, so the peek is
 * never a permanent oracle.
 */
describe('OAuthService.peekState', () => {
  beforeEach(() => {
    where.mockClear();
    rows = [];
  });

  it('only reads a state by its token whose expiry is within the grace period', async () => {
    rows = [{ additionalData: { connectLinkId: 'l1' } }];
    const peeked = await new OAuthService().peekState('tok-123');
    expect(peeked).toEqual({ additionalData: { connectLinkId: 'l1' } });

    const { sql, params } = new PgDialect().sqlToQuery(
      where.mock.calls[0][0] as SQL,
    );
    expect(sql).toMatch(/"oauth_states"\."state_token" = \$\d/);
    expect(sql).toMatch(/"oauth_states"\."expires_at" > \$\d/);
    expect(params).toContain('tok-123');
  });

  it('the cutoff is one hour before now, as a named constant', () => {
    expect(LINK_STATE_PEEK_GRACE_MS).toBe(60 * 60 * 1000);
  });

  describe('grace period', () => {
    const NOW = new Date('2026-11-14T12:00:00.000Z');
    beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
    afterEach(() => jest.useRealTimers());

    /** The expires_at cutoff bound into the query's predicate. */
    async function cutoffOfPeek(): Promise<Date> {
      rows = [{ additionalData: null }];
      await new OAuthService().peekState('tok');
      const { params } = new PgDialect().sqlToQuery(
        where.mock.calls[0][0] as SQL,
      );
      const bound = params.find(
        (p) =>
          p instanceof Date || (typeof p === 'string' && /^\d{4}-/.test(p)),
      );
      expect(bound).toBeDefined();
      return new Date(bound as Date | string);
    }

    it('answers for a state that expired 20 minutes ago', async () => {
      const cutoff = await cutoffOfPeek();
      const expiredTwentyMinutesAgo = new Date(NOW.getTime() - 20 * 60 * 1000);
      expect(expiredTwentyMinutesAgo.getTime()).toBeGreaterThan(
        cutoff.getTime(),
      );
    });

    it('stops answering once a state expired more than an hour ago', async () => {
      const cutoff = await cutoffOfPeek();
      expect(cutoff.getTime()).toBe(NOW.getTime() - 60 * 60 * 1000);
      const expiredTwoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
      expect(expiredTwoHoursAgo.getTime()).toBeLessThan(cutoff.getTime());
    });
  });

  it('an unknown or expired state -> null', async () => {
    rows = [];
    await expect(new OAuthService().peekState('gone')).resolves.toBeNull();
  });

  it('never marks the state used', async () => {
    rows = [{ additionalData: null }];
    const service = new OAuthService();
    await service.peekState('tok');
    const { db } = jest.requireMock<{ db: { update: jest.Mock } }>(
      '../../drizzle/db',
    );
    expect(db.update).not.toHaveBeenCalled();
  });
});
