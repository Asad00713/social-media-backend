import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
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
  refreshToken: 'enc:rt',
  connectionStatus: 'connected',
};

function setup() {
  const sets: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [CHANNEL] }) }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => {
        sets.push(data);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
  const oauth = { refreshAccessToken: jest.fn() };
  const health = {
    markExpired: jest
      .fn<Promise<void>, [number, { lastError: string }]>()
      .mockResolvedValue(undefined),
  };
  const processor = new TokenRefreshProcessor(
    oauth as never,
    db as never,
    health as never,
  );
  return { processor, oauth, health, sets };
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

describe('TokenRefreshProcessor expiry', () => {
  it('marks the channel expired through the notifier when the refresh fails', async () => {
    const { processor, oauth, health, sets } = setup();
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(processor.process(job)).resolves.toEqual({ ok: false });
    expect(health.markExpired).toHaveBeenCalledTimes(1);
    expect(health.markExpired).toHaveBeenCalledWith(5, {
      lastError: 'Refresh failed: invalid_grant',
      updatedAt: expect.any(Date) as Date,
    });
    expect(sets).toHaveLength(0);
  });

  it('truncates a long failure reason to 500 characters', async () => {
    const { processor, oauth, health } = setup();
    oauth.refreshAccessToken.mockRejectedValue(new Error('x'.repeat(900)));
    await processor.process(job);
    expect(health.markExpired.mock.calls[0][1].lastError).toHaveLength(500);
  });

  it('leaves the status alone when the refresh works', async () => {
    const { processor, oauth, health, sets } = setup();
    oauth.refreshAccessToken.mockResolvedValue({
      accessToken: 'at',
      expiresIn: 3600,
    });
    await expect(processor.process(job)).resolves.toEqual({ ok: true });
    expect(health.markExpired).not.toHaveBeenCalled();
    expect(sets[0]).toMatchObject({ connectionStatus: 'connected' });
  });
});
