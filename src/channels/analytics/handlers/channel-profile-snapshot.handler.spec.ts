import { Logger } from '@nestjs/common';
import type { ChannelHealthNotifier } from '../../services/channel-health-notifier.service';
import { ChannelProfileSnapshotHandler } from './channel-profile-snapshot.handler';

jest.mock('../../../common/utils/encryption.util', () => ({
  decrypt: (v: string) => v,
}));

const CHANNEL = {
  id: 5,
  workspaceId: 'ws-1',
  platform: 'instagram',
  accessToken: 'tok',
  metadata: {},
};

/** select #1 = the channel; select #2 = its sync state. */
function make(opts: { failures: number; message?: string }) {
  const selects: unknown[][] = [
    [CHANNEL],
    [{ consecutiveFailures: opts.failures }],
  ];
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selects.shift() ?? []) }),
      }),
    })),
    insert: jest.fn(() => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    })),
    update: jest.fn(),
  };
  const adapter = {
    estimateQuotaCost: () => 1,
    fetchProfileSnapshot: jest.fn(() =>
      Promise.resolve({
        status: 'failed',
        error: { code: 'auth_failed', message: opts.message },
      }),
    ),
  };
  const registry = { has: () => true, get: () => adapter };
  const quota = {
    tryConsume: () => Promise.resolve({ allowed: true }),
    shouldLogOncePerDay: () => Promise.resolve(false),
  };
  const events = { emit: jest.fn() };
  const health = {
    markExpired: jest.fn<
      Promise<void>,
      Parameters<ChannelHealthNotifier['markExpired']>
    >(() => Promise.resolve()),
  };
  const handler = new ChannelProfileSnapshotHandler(
    registry as never,
    quota as never,
    events as never,
    db,
    health as unknown as ChannelHealthNotifier,
  );
  return { handler, db, health };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('ChannelProfileSnapshotHandler auth failures', () => {
  it('the third auth failure in a row marks the channel expired through the notifier', async () => {
    const { handler, db, health } = make({
      failures: 2,
      message: `Token rejected ${'x'.repeat(600)}`,
    });
    await expect(
      handler.handle({ channelId: 5, workspaceId: 'ws-1' }),
    ).resolves.toEqual({ ok: false });

    expect(health.markExpired).toHaveBeenCalledTimes(1);
    const [id, fields] = health.markExpired.mock.calls[0];
    expect(id).toBe(5);
    // Exactly the fields this writer always set; the notifier adds the status.
    expect(fields).toEqual({
      lastError: `Token rejected ${'x'.repeat(600)}`.slice(0, 500),
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a missing message is written as a null lastError', async () => {
    const { handler, health } = make({ failures: 4 });
    await handler.handle({ channelId: 5, workspaceId: 'ws-1' });
    expect(health.markExpired).toHaveBeenCalledWith(5, { lastError: null });
  });

  it('the first and second auth failures leave the channel alone', async () => {
    for (const failures of [0, 1]) {
      const { handler, health } = make({ failures, message: 'Token rejected' });
      await handler.handle({ channelId: 5, workspaceId: 'ws-1' });
      expect(health.markExpired).not.toHaveBeenCalled();
    }
  });
});
