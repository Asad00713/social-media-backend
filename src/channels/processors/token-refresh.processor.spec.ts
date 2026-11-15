import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TokenRefreshProcessor } from './token-refresh.processor';

jest.mock('../../common/utils/encryption.util', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

const CHANNEL = {
  id: 5,
  workspaceId: 'ws-1',
  platform: 'instagram',
  accountName: 'Lumiere Cafe',
  accountType: 'business_account',
  refreshToken: 'enc:rt',
  connectionStatus: 'connected',
};

function setup(opts: { moved: number }) {
  const sets: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  const returning = jest
    .fn()
    .mockResolvedValue(Array.from({ length: opts.moved }, () => ({ id: 5 })));
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [CHANNEL] }) }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => {
        sets.push(data);
        return {
          where: (w: unknown) => {
            wheres.push(w);
            // A success write awaits `where`; the failure write chains on.
            return Object.assign(Promise.resolve(undefined), { returning });
          },
        };
      },
    }),
  };
  const oauth = { refreshAccessToken: jest.fn() };
  const health = { expired: jest.fn().mockResolvedValue(undefined) };
  const processor = new TokenRefreshProcessor(
    oauth as never,
    db as never,
    health as never,
  );
  return { processor, oauth, health, sets, wheres };
}

const job = { name: 'token-refresh', data: { channelId: 5 } } as Job<{
  channelId: number;
}>;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('TokenRefreshProcessor reconnect email', () => {
  it('emails on the connected to expired transition', async () => {
    const { processor, oauth, health, sets } = setup({ moved: 1 });
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(processor.process(job)).resolves.toEqual({ ok: false });
    expect(sets[0]).toMatchObject({ connectionStatus: 'expired' });
    expect(health.expired).toHaveBeenCalledTimes(1);
    expect(health.expired).toHaveBeenCalledWith(CHANNEL, sets[0].updatedAt);
  });

  it('sends nothing when the channel was already expired', async () => {
    const { processor, oauth, health } = setup({ moved: 0 });
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(processor.process(job)).resolves.toEqual({ ok: false });
    expect(health.expired).not.toHaveBeenCalled();
  });

  it('only updates a row that is not yet expired', async () => {
    const { processor, oauth, wheres } = setup({ moved: 1 });
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await processor.process(job);
    const q = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(q.sql).toMatch(/"connection_status" <> \$/);
    expect(q.params).toContain('expired');
  });

  it('sends nothing when the refresh works', async () => {
    const { processor, oauth, health } = setup({ moved: 1 });
    oauth.refreshAccessToken.mockResolvedValue({
      accessToken: 'at',
      expiresIn: 3600,
    });
    await expect(processor.process(job)).resolves.toEqual({ ok: true });
    expect(health.expired).not.toHaveBeenCalled();
  });

  it('still finishes the job when the email step throws', async () => {
    const { processor, oauth, health } = setup({ moved: 1 });
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    health.expired.mockRejectedValue(new Error('smtp down'));
    await expect(processor.process(job)).resolves.toEqual({ ok: false });
  });
});
