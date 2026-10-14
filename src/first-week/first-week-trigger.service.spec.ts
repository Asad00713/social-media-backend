import { FirstWeekTriggerService } from './first-week-trigger.service';

const make = (inserted = true) => {
  const repo = {
    insertProfileIfAbsent: jest.fn(async () => inserted),
    setStatus: jest.fn(async () => undefined),
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
    expect(await svc.onChannelBackfilled('w1', 'u1')).toBe('started');
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
    expect(await svc.onChannelBackfilled('w1', 'u1')).toBe('exists');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('omits userId when the channel has no connecting user', async () => {
    const { svc, queue } = make(true);
    await svc.onChannelBackfilled('w1', null);
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId: 'w1',
      mode: 'posts',
    });
  });

  it('flips the profile to failed (so the person can retry) when enqueueing fails', async () => {
    const { svc, repo, queue } = make(true);
    queue.enqueue.mockRejectedValue(new Error('redis down'));
    expect(await svc.onChannelBackfilled('w1', 'u1')).toBe('error');
    expect(repo.setStatus).toHaveBeenCalledWith(
      'w1',
      'failed',
      'Could not start: redis down',
    );
  });
});
