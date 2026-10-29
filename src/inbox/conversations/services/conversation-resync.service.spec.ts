import { QUEUES } from '../../../queue/queue.module';
import {
  ConversationResyncProcessor,
  ConversationResyncService,
  resyncJobId,
} from './conversation-resync.service';
import {
  ConversationSyncService,
  SyncThreadsError,
} from './conversation-sync.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('resyncJobId', () => {
  it('is colon-free, deterministic and distinct per thread', () => {
    const a = resyncJobId(WS, '7:mention:abc');
    expect(a).not.toContain(':');
    expect(a.startsWith(`resync-${WS}-`)).toBe(true);
    expect(resyncJobId(WS, '7:mention:abc')).toBe(a);
    expect(resyncJobId(WS, '7:other')).not.toBe(a);
  });
});

describe('ConversationResyncService', () => {
  const build = () => {
    const queue = { add: jest.fn(async () => undefined) };
    const sync = { syncThreads: jest.fn(), syncThread: jest.fn() };
    const service = new ConversationResyncService(
      queue as never,
      sync as never,
    );
    return { service, queue, sync };
  };

  it('queues a deduped job with 5 attempts and exponential backoff', async () => {
    const { service, queue } = build();
    await service.enqueue(WS, '7:p1');
    expect(QUEUES.INBOX_RESYNC).toBe('inbox-resync');
    expect(queue.add).toHaveBeenCalledWith(
      'resync',
      { workspaceId: WS, threadKey: '7:p1' },
      expect.objectContaining({
        jobId: resyncJobId(WS, '7:p1'),
        attempts: 5,
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );
  });

  it('never throws when the queue is down', async () => {
    const { service, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.enqueue(WS, '7:p1')).resolves.toBeUndefined();
  });

  it('syncOrEnqueue queues only the keys that failed', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockRejectedValueOnce(
      new SyncThreadsError([{ threadKey: '7:b', error: new Error('x') }], []),
    );
    await service.syncOrEnqueue(WS, ['7:a', '7:b']);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'resync',
      { workspaceId: WS, threadKey: '7:b' },
      expect.anything(),
    );
  });

  it('syncOrEnqueue queues every key when the failure is not per-key', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockRejectedValueOnce(new Error('pool gone'));
    await service.syncOrEnqueue(WS, ['7:a', '7:b']);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('syncOrEnqueue queues nothing when every sync succeeds', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockResolvedValueOnce([]);
    await service.syncOrEnqueue(WS, ['7:a']);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('ConversationResyncProcessor', () => {
  it('re-runs syncThread for the job', async () => {
    const sync = { syncThread: jest.fn(async () => undefined) };
    const proc = new ConversationResyncProcessor(sync as never);
    await proc.process({
      data: { workspaceId: WS, threadKey: '7:p1' },
    } as never);
    expect(sync.syncThread).toHaveBeenCalledWith(WS, '7:p1');
  });
});

describe('ConversationSyncService.syncThreads', () => {
  it('tries every key past a failure, then reports the failures', async () => {
    const service = new ConversationSyncService({} as never, {} as never);
    const spy = jest
      .spyOn(service, 'syncThread')
      .mockImplementation(async (_ws, key) => {
        if (key === 'bad') throw new Error('nope');
        return { conversationId: key } as never;
      });
    await expect(
      service.syncThreads(WS, ['a', 'bad', 'c', 'a']),
    ).rejects.toMatchObject({
      name: 'SyncThreadsError',
      failures: [{ threadKey: 'bad' }],
      results: [{ conversationId: 'a' }, { conversationId: 'c' }],
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
