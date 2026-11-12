import { ChannelSnapshotsScheduler } from './channel-snapshots.scheduler';

function build(rows: Array<Record<string, unknown>>) {
  const add = jest.fn(async () => undefined);
  const db = { select: () => ({ from: async () => rows }) };
  const scheduler = new ChannelSnapshotsScheduler(
    { add } as any,
    db as any,
    {} as any,
  );
  return { scheduler, add };
}

const row = (
  id: number,
  platform: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  platform,
  isActive: true,
  connectionStatus: 'connected',
  ...extra,
});

describe('ChannelSnapshotsScheduler.enqueueAudienceRefresh', () => {
  afterEach(() => jest.useRealTimers());

  it('enqueues only active, connected instagram/threads/facebook channels', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T03:30:00Z'));
    const { scheduler, add } = build([
      row(1, 'instagram'),
      row(2, 'threads'),
      row(3, 'facebook'),
      row(4, 'tiktok'),
      row(5, 'youtube'),
      row(6, 'instagram', { isActive: false }),
      row(7, 'facebook', { connectionStatus: 'expired' }),
      row(8, 'threads', { connectionStatus: 'revoked' }),
    ]);
    await scheduler.enqueueAudienceRefresh();

    const calls = add.mock.calls as unknown as Array<[string, any, any]>;
    expect(calls.map((c) => c[0])).toEqual([
      'channel-audience-refresh',
      'channel-audience-refresh',
      'channel-audience-refresh',
    ]);
    expect(calls.map((c) => c[1])).toEqual([
      { channelId: 1 },
      { channelId: 2 },
      { channelId: 3 },
    ]);
    expect(calls.map((c) => c[2].delay)).toEqual([0, 200, 400]);
    for (const c of calls) {
      expect(c[2].jobId).toMatch(/^audience-\d+-\d{4}-\d{2}-\d{2}$/);
    }
    expect(calls[0][2].jobId).toBe('audience-1-2026-11-12');
  });

  it('enqueues nothing when no channel qualifies', async () => {
    const { scheduler, add } = build([row(1, 'twitter')]);
    await scheduler.enqueueAudienceRefresh();
    expect(add).not.toHaveBeenCalled();
  });
});
