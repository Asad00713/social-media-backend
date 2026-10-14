import { FirstWeekTriggerService } from './first-week-trigger.service';

const NOW = new Date('2026-10-14T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const make = (inserted = true, ageDays = 1) => {
  const repo = {
    insertProfileIfAbsent: jest.fn(async () => inserted),
    setStatus: jest.fn(async () => undefined),
    getWorkspaceCreatedAt: jest.fn(
      async () => new Date(NOW.getTime() - ageDays * DAY),
    ),
  };
  const queue = { enqueue: jest.fn(async () => undefined) };
  return {
    repo,
    queue,
    svc: new FirstWeekTriggerService(repo as any, queue as any),
  };
};

describe('FirstWeekTriggerService.onChannelBackfilled', () => {
  it('inserts a reading profile and enqueues posts mode', async () => {
    const { svc, repo, queue } = make(true);
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('started');
    expect(repo.insertProfileIfAbsent).toHaveBeenCalledWith('w1', {
      source: 'posts',
      status: 'reading',
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId: 'w1',
      mode: 'posts',
      userId: 'u1',
    });
  });

  it('second channel sees the row and does nothing', async () => {
    const { svc, queue } = make(false);
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('exists');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('omits userId when the channel has no connecting user', async () => {
    const { svc, queue } = make(true);
    await svc.onChannelBackfilled('w1', null, NOW);
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId: 'w1',
      mode: 'posts',
    });
  });

  it('flips the profile to failed (so the person can retry) when enqueueing fails', async () => {
    const { svc, repo, queue } = make(true);
    queue.enqueue.mockRejectedValue(new Error('redis down'));
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('error');
    expect(repo.setStatus).toHaveBeenCalledWith(
      'w1',
      'failed',
      'Could not start: redis down',
    );
  });
});

describe('first week only starts for a new workspace', () => {
  it('does nothing for a workspace older than 14 days (no profile, no run)', async () => {
    const { svc, repo, queue } = make(true, 15);
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('skipped_old');
    expect(repo.insertProfileIfAbsent).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('still starts at exactly 14 days', async () => {
    const { svc } = make(true, 14);
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('started');
  });

  it('does nothing when the workspace cannot be found', async () => {
    const { svc, repo, queue } = make(true);
    repo.getWorkspaceCreatedAt.mockResolvedValue(null as any);
    expect(await svc.onChannelBackfilled('w1', 'u1', NOW)).toBe('skipped_old');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('FirstWeekTriggerService.onBackfillUnreadable', () => {
  it('seeds a needs_description profile for a new workspace and enqueues nothing', async () => {
    const { svc, repo, queue } = make(true);
    expect(await svc.onBackfillUnreadable('w1', NOW)).toBe('needs_description');
    expect(repo.insertProfileIfAbsent).toHaveBeenCalledWith('w1', {
      source: 'posts',
      status: 'needs_description',
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('never downgrades an existing profile (insert-if-absent)', async () => {
    const { svc, repo } = make(false);
    expect(await svc.onBackfillUnreadable('w1', NOW)).toBe('exists');
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it('does nothing for a veteran workspace', async () => {
    const { svc, repo } = make(true, 30);
    expect(await svc.onBackfillUnreadable('w1', NOW)).toBe('skipped_old');
    expect(repo.insertProfileIfAbsent).not.toHaveBeenCalled();
  });
});
