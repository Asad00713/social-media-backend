import { Logger } from '@nestjs/common';
import { QUEUES } from '../../../queue/queue.module';
import type { SyncIntent } from '../lib/lifecycle';
import {
  ConversationResyncProcessor,
  ConversationResyncService,
  rekeyJobId,
  resyncJobId,
  type ConversationResyncJob,
} from './conversation-resync.service';
import {
  ConversationSyncService,
  SyncThreadsError,
} from './conversation-sync.service';

const WS = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-10-26T10:00:00.000Z');

type JobState = 'failed' | 'completed' | 'active' | 'waiting' | 'delayed';

interface FakeJob {
  getState: jest.Mock<Promise<JobState>, []>;
  remove: jest.Mock<Promise<void>, []>;
}

/** A fake queue keyed by jobId, behaving like BullMQ: an existing id is a duplicate. */
function fakeQueue() {
  const jobs = new Map<string, FakeJob>();
  const makeJob = (id: string, state: JobState): FakeJob => ({
    getState: jest.fn(() => Promise.resolve(state)),
    remove: jest.fn(() => {
      jobs.delete(id);
      return Promise.resolve();
    }),
  });
  const add = jest.fn(
    (_name: string, _data: unknown, opts: { jobId: string }) => {
      if (!jobs.has(opts.jobId)) {
        jobs.set(opts.jobId, makeJob(opts.jobId, 'waiting'));
      }
      return Promise.resolve(undefined);
    },
  );
  const getJob = jest.fn((id: string) => Promise.resolve(jobs.get(id)));
  const put = (id: string, state: JobState): FakeJob => {
    const job = makeJob(id, state);
    jobs.set(id, job);
    return job;
  };
  return { add, getJob, put, jobs };
}

function build() {
  const queue = fakeQueue();
  const sync = {
    syncThreads: jest.fn(),
    syncThread: jest.fn(),
    rekey: jest.fn(),
  };
  const service = new ConversationResyncService(queue as never, sync as never);
  return { service, queue, sync };
}

describe('resyncJobId / rekeyJobId', () => {
  it('are colon-free, deterministic and distinct', () => {
    const a = resyncJobId(WS, '7:mention:abc');
    expect(a).not.toContain(':');
    expect(a.startsWith(`resync-${WS}-`)).toBe(true);
    expect(resyncJobId(WS, '7:mention:abc')).toBe(a);
    expect(resyncJobId(WS, '7:other')).not.toBe(a);
    const r = rekeyJobId(WS, '7:mention:abc', '7:p9');
    expect(r).not.toContain(':');
    expect(rekeyJobId(WS, '7:p9', '7:mention:abc')).not.toBe(r);
  });
});

describe('ConversationResyncService.enqueue', () => {
  it('queues a deduped job with 5 attempts and exponential backoff', async () => {
    const { service, queue } = build();
    await service.enqueue(WS, '7:p1');
    expect(QUEUES.INBOX_RESYNC).toBe('inbox-resync');
    expect(queue.add).toHaveBeenCalledWith(
      'resync',
      { type: 'sync', workspaceId: WS, threadKey: '7:p1' },
      expect.objectContaining({
        jobId: resyncJobId(WS, '7:p1'),
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('never throws when the queue is down', async () => {
    const { service, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.enqueue(WS, '7:p1')).resolves.toBeUndefined();
  });

  it('does not add a second job while one is still waiting to run', async () => {
    const { service, queue } = build();
    queue.put(resyncJobId(WS, '7:p1'), 'waiting');
    await service.enqueue(WS, '7:p1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'] as const)(
    'removes a %s job with the same id, then queues again (BullMQ keeps the id otherwise)',
    async (state) => {
      const { service, queue } = build();
      const old = queue.put(resyncJobId(WS, '7:p1'), state);
      await service.enqueue(WS, '7:p1');
      expect(old.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it('a failure arriving while the job is RUNNING queues a follow-up run', async () => {
    const { service, queue } = build();
    queue.put(resyncJobId(WS, '7:p1'), 'active');
    await service.enqueue(WS, '7:p1');
    expect(queue.add).toHaveBeenCalledTimes(1);
    const jobId = queue.add.mock.calls[0][2].jobId;
    expect(jobId).toBe(`${resyncJobId(WS, '7:p1')}-next`);
    expect(jobId).not.toContain(':');
  });

  it('carries the authored intent in the job payload', async () => {
    const { service, queue } = build();
    await service.enqueue(WS, '7:D1', {
      kind: 'outbound',
      userId: 'u1',
      markDone: false,
      at: AT,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'resync',
      {
        type: 'sync',
        workspaceId: WS,
        threadKey: '7:D1',
        intent: { userId: 'u1', markDone: false, at: AT.toISOString() },
      },
      expect.anything(),
    );
  });
});

describe('ConversationResyncService.enqueueRekey', () => {
  it('queues a rekey job carrying both keys under a colon-free id', async () => {
    const { service, queue } = build();
    await service.enqueueRekey(WS, '7:mention:m7', '7:p9');
    expect(queue.add).toHaveBeenCalledWith(
      'rekey',
      {
        type: 'rekey',
        workspaceId: WS,
        fromKey: '7:mention:m7',
        toKey: '7:p9',
      },
      expect.objectContaining({
        jobId: rekeyJobId(WS, '7:mention:m7', '7:p9'),
        attempts: 5,
      }),
    );
  });
});

describe('ConversationResyncService.syncOrEnqueue', () => {
  it('queues only the keys that failed', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockRejectedValueOnce(
      new SyncThreadsError([{ threadKey: '7:b', error: new Error('x') }], []),
    );
    await service.syncOrEnqueue(WS, ['7:a', '7:b']);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).toMatchObject({ threadKey: '7:b' });
  });

  it('queues every key when the failure is not per-key', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockRejectedValueOnce(new Error('pool gone'));
    await service.syncOrEnqueue(WS, ['7:a', '7:b']);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('queues nothing when every sync succeeds', async () => {
    const { service, queue, sync } = build();
    sync.syncThreads.mockResolvedValueOnce([]);
    await service.syncOrEnqueue(WS, ['7:a']);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('logs each failed key together with its own error', async () => {
    const { service, sync } = build();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sync.syncThreads.mockRejectedValueOnce(
      new SyncThreadsError(
        [
          { threadKey: '7:a', error: new Error('lock timeout') },
          { threadKey: '7:b', error: new Error('connection reset') },
        ],
        [],
      ),
    );
    await service.syncOrEnqueue(WS, ['7:a', '7:b']);
    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('7:a');
    expect(text).toContain('lock timeout');
    expect(text).toContain('7:b');
    expect(text).toContain('connection reset');
    log.mockRestore();
  });
});

describe('ConversationResyncProcessor', () => {
  const run = (data: ConversationResyncJob, name = 'resync') => {
    const sync = {
      syncThread: jest.fn<Promise<void>, [string, string, SyncIntent]>(() =>
        Promise.resolve(),
      ),
      rekey: jest.fn<Promise<void>, [string, string, string]>(() =>
        Promise.resolve(),
      ),
    };
    const proc = new ConversationResyncProcessor(sync as never);
    return { sync, go: () => proc.process({ name, data } as never) };
  };

  it('re-runs a plain refresh sync', async () => {
    const { sync, go } = run({
      type: 'sync',
      workspaceId: WS,
      threadKey: '7:p1',
    });
    await go();
    expect(sync.syncThread).toHaveBeenCalledWith(WS, '7:p1', {
      kind: 'refresh',
    });
  });

  it('replays the authored outbound intent so the retry is not Done via platform', async () => {
    const { sync, go } = run({
      type: 'sync',
      workspaceId: WS,
      threadKey: '7:D1',
      intent: { userId: 'u1', markDone: false, at: AT.toISOString() },
    });
    await go();
    expect(sync.syncThread).toHaveBeenCalledWith(WS, '7:D1', {
      kind: 'outbound',
      userId: 'u1',
      markDone: false,
      at: AT,
    });
  });

  it('re-runs a rekey job with both keys', async () => {
    const { sync, go } = run(
      {
        type: 'rekey',
        workspaceId: WS,
        fromKey: '7:mention:m7',
        toKey: '7:p9',
      },
      'rekey',
    );
    await go();
    expect(sync.rekey).toHaveBeenCalledWith(WS, '7:mention:m7', '7:p9');
  });

  it('logs and rethrows a failure so BullMQ retries it', async () => {
    const { sync, go } = run({
      type: 'sync',
      workspaceId: WS,
      threadKey: '7:p1',
    });
    sync.syncThread.mockRejectedValueOnce(new Error('db down'));
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await expect(go()).rejects.toThrow('db down');
    expect(String(log.mock.calls[0][0])).toContain('7:p1');
    log.mockRestore();
  });
});

describe('ConversationSyncService.syncThreads', () => {
  it('tries every key past a failure, then reports the failures', async () => {
    const service = new ConversationSyncService({} as never, {} as never);
    const spy = jest
      .spyOn(service, 'syncThread')
      .mockImplementation((_ws, key) =>
        key === 'bad'
          ? Promise.reject(new Error('nope'))
          : Promise.resolve({ conversationId: key } as never),
      );
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
