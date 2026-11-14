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

import { OAuthService } from './oauth.service';

/**
 * peekState must stay a short-lived read: it decides where a callback error
 * is shown for a link visitor, and the link page URL it leads to carries the
 * raw link token. An old state must not keep answering.
 */
describe('OAuthService.peekState', () => {
  beforeEach(() => {
    where.mockClear();
    rows = [];
  });

  it('only reads a state by its token that has not expired yet', async () => {
    rows = [{ additionalData: { connectLinkId: 'l1' } }];
    const peeked = await new OAuthService().peekState('tok-123');
    expect(peeked).toEqual({ additionalData: { connectLinkId: 'l1' } });

    const { sql, params } = new PgDialect().sqlToQuery(
      where.mock.calls[0][0] as SQL,
    );
    expect(sql).toMatch(/"oauth_states"\."state_token" = \$\d/);
    expect(sql).toMatch(/"oauth_states"\."expires_at" > /);
    expect(params).toContain('tok-123');
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
