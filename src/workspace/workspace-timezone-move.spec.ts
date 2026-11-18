import { ConflictException, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { PostTarget } from '../drizzle/schema/posts.schema';
import { PostRescheduleService } from '../posts/services/post-reschedule.service';
import { WorkspaceTimezoneMoveProcessor } from './workspace-timezone-move.processor';
import {
  TZ_MOVE_INLINE_LIMIT,
  WorkspaceTimezoneMoveService,
  planPostMoves,
  type TimezoneMoveJob,
} from './workspace-timezone-move.service';

// The rules that need no database. The DB twin
// (workspace-timezone-move.db.spec.ts) proves the writes against real rows.
const NOW = new Date('2026-11-17T12:00:00Z');
const KARACHI_9AM = new Date('2027-01-15T04:00:00Z');
const PARIS_9AM = new Date('2027-01-15T08:00:00Z');
const NEW_YORK_9AM = new Date('2027-01-15T14:00:00Z');

function target(channelId: string, extra: Partial<PostTarget> = {}) {
  return {
    channelId,
    platform: 'twitter',
    status: 'scheduled',
    ...extra,
  } as PostTarget;
}

describe('planPostMoves', () => {
  const zones = { '1': 'Asia/Karachi', '2': 'Europe/Paris', '3': null };

  it("keeps each post's wall-clock time, read in its first channel's old zone", () => {
    expect(
      planPostMoves(
        [
          { id: 'a', scheduledAt: KARACHI_9AM, targets: [target('1')] },
          {
            id: 'b',
            scheduledAt: PARIS_9AM,
            targets: [target('2'), target('1')],
          },
        ],
        zones,
        'Asia/Karachi',
        'America/New_York',
        NOW,
      ),
    ).toEqual([
      { postId: 'a', from: KARACHI_9AM, at: NEW_YORK_9AM },
      { postId: 'b', from: PARIS_9AM, at: NEW_YORK_9AM },
    ]);
  });

  it('falls back to fromZone for a channel with no zone or no target', () => {
    expect(
      planPostMoves(
        [
          { id: 'a', scheduledAt: KARACHI_9AM, targets: [target('3')] },
          { id: 'b', scheduledAt: KARACHI_9AM, targets: [] },
          { id: 'c', scheduledAt: KARACHI_9AM, targets: [target('99')] },
        ],
        zones,
        'Asia/Karachi',
        'America/New_York',
        NOW,
      ).map((m) => m.at),
    ).toEqual([NEW_YORK_9AM, NEW_YORK_9AM, NEW_YORK_9AM]);
  });

  it('skips a held post: it is jobless on purpose until its channel resumes', () => {
    expect(
      planPostMoves(
        [
          {
            id: 'held',
            scheduledAt: KARACHI_9AM,
            targets: [
              target('2'),
              target('1', {
                heldAt: '2027-01-01T00:00:00Z',
                heldReason: 'channel_paused',
              }),
            ],
          },
        ],
        zones,
        'Asia/Karachi',
        'America/New_York',
        NOW,
      ),
    ).toEqual([]);
  });

  it('skips a post with no time and one whose instant does not change', () => {
    expect(
      planPostMoves(
        [
          { id: 'none', scheduledAt: null, targets: [target('1')] },
          { id: 'same', scheduledAt: KARACHI_9AM, targets: [target('1')] },
        ],
        zones,
        'Asia/Karachi',
        'Asia/Karachi',
        NOW,
      ),
    ).toEqual([]);
  });

  it('a new instant already past becomes now', () => {
    // 09:00 Karachi on 17 Nov is 04:00Z; 09:00 New York is 14:00Z, after NOW.
    // Going the other way, 09:00 New York (14:00Z) to 09:00 Karachi (04:00Z)
    // lands before NOW.
    expect(
      planPostMoves(
        [
          {
            id: 'a',
            scheduledAt: new Date('2026-11-17T14:00:00Z'),
            targets: [],
          },
        ],
        {},
        'America/New_York',
        'Asia/Karachi',
        NOW,
      ),
    ).toEqual([
      { postId: 'a', from: new Date('2026-11-17T14:00:00Z'), at: NOW },
    ]);
  });

  it('keeps the milliseconds of the stored time', () => {
    const at = new Date(KARACHI_9AM.getTime() + 250);
    expect(
      planPostMoves(
        [{ id: 'a', scheduledAt: at, targets: [target('1')] }],
        zones,
        'Asia/Karachi',
        'America/New_York',
        NOW,
      )[0].at,
    ).toEqual(new Date(NEW_YORK_9AM.getTime() + 250));
  });
});

describe('PostRescheduleService.moveTo', () => {
  const OLD_AT = new Date(Date.now() + 30 * 60_000);

  /**
   * A db whose transaction records what happens in it, in order. `row` is
   * what the locked read finds; `jobIdWriteFailures` makes the job id write
   * fail that many times; `addFailures` makes `add` fail that many times.
   */
  function make(opts: {
    row?: { jobId: string | null; scheduledAt: Date | null };
    lockedJobs?: string[];
    addFailures?: number;
    jobIdWriteFailures?: number;
  }) {
    const calls: string[] = [];
    const sets: Record<string, unknown>[] = [];
    let jobIdWriteFailures = opts.jobIdWriteFailures ?? 0;
    let addFailures = opts.addFailures ?? 0;
    let inTransaction = false;
    const forUpdate = jest.fn(() => {
      calls.push('lock-row');
      return Promise.resolve(opts.row ? [opts.row] : []);
    });
    const setter = (values: Record<string, unknown>) => {
      sets.push(values);
      calls.push('jobId' in values ? 'write-jobId' : 'write-time');
      return { where: () => Promise.resolve() };
    };
    const tx = {
      select: jest.fn(() => ({
        from: () => ({ where: () => ({ for: forUpdate }) }),
      })),
      update: jest.fn(() => ({ set: setter })),
      transaction: jest.fn(
        (fn: (sp: { update: () => unknown }) => Promise<unknown>) => {
          if (jobIdWriteFailures > 0) {
            jobIdWriteFailures -= 1;
            calls.push('write-jobId-failed');
            return Promise.reject(new Error('connection reset'));
          }
          return fn({ update: () => ({ set: setter }) });
        },
      ),
    };
    const db = {
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn(tx);
        } finally {
          inTransaction = false;
        }
      }),
    };
    const removed: string[] = [];
    const added: { jobId: string; delay: number }[] = [];
    const queue = {
      getJob: jest.fn((id: string) =>
        Promise.resolve({
          remove: jest.fn(() => {
            if (opts.lockedJobs?.includes(id)) {
              return Promise.reject(new Error('job is locked'));
            }
            calls.push(`remove:${id}`);
            removed.push(id);
            return Promise.resolve();
          }),
        }),
      ),
      add: jest.fn(
        (
          _name: string,
          _data: unknown,
          o: { jobId: string; delay: number; attempts: number },
        ) => {
          // Every job swap happens while the row lock is held.
          expect(inTransaction).toBe(true);
          if (addFailures > 0) {
            addFailures -= 1;
            calls.push('add-failed');
            return Promise.reject(new Error('redis timeout'));
          }
          calls.push(`add:${o.jobId}`);
          added.push({ jobId: o.jobId, delay: o.delay });
          return Promise.resolve({ id: o.jobId });
        },
      ),
    };
    const svc = new PostRescheduleService(db as never, queue as never);
    return { svc, calls, sets, removed, added, queue, forUpdate };
  }

  it('locks the row, then swaps both jobs for composer-publish-<id> and records it, in one transaction', async () => {
    const { svc, calls, sets, queue, forUpdate } = make({
      row: { jobId: 'post-p1-old', scheduledAt: OLD_AT },
    });
    const at = new Date(Date.now() + 60 * 60_000);

    await expect(svc.moveTo('ws-1', 'p1', at)).resolves.toBe('moved');

    expect(forUpdate).toHaveBeenCalledWith('update');
    expect(calls).toEqual([
      'lock-row',
      'write-time',
      'remove:composer-publish-p1',
      'remove:post-p1-old',
      'add:composer-publish-p1',
      'write-jobId',
    ]);
    expect(sets[0]).toEqual({ scheduledAt: at });
    const [name, data, o] = queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { jobId: string; delay: number; attempts: number },
    ];
    expect(name).toBe('publish');
    expect(data).toEqual({ postId: 'p1' });
    expect(o.jobId).not.toContain(':');
    expect(o.attempts).toBe(3);
    expect(o.delay).toBeGreaterThan(59 * 60_000);
    expect(sets[1]).toEqual({ jobId: 'composer-publish-p1' });
  });

  it('a past instant gets delay 0', async () => {
    const { svc, added } = make({ row: { jobId: null, scheduledAt: OLD_AT } });
    await svc.moveTo('ws-1', 'p1', new Date(Date.now() - 1000));
    expect(added[0].delay).toBe(0);
  });

  it('touches no job of a post that is no longer movable', async () => {
    const { svc, queue } = make({});
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(), { ifScheduledAt: new Date() }),
    ).resolves.toBe('not-movable');
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws and adds nothing when the old composer job cannot be removed', async () => {
    // Adding the same id would hand back the OLD job at its OLD delay.
    const { svc, queue } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      lockedJobs: ['composer-publish-p1'],
    });
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 60_000)),
    ).rejects.toThrow('composer-publish-p1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a recorded legacy job that cannot be removed is only logged', async () => {
    const { svc, added } = make({
      row: { jobId: 'post-p1-old', scheduledAt: OLD_AT },
      lockedJobs: ['post-p1-old'],
    });
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 60_000)),
    ).resolves.toBe('moved');
    expect(added).toHaveLength(1);
  });

  it('add fails after the old job was removed: the old job goes back at previousAt, then it throws', async () => {
    const { svc, calls, added } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      addFailures: 1,
    });
    const previousAt = new Date(Date.now() + 20 * 60_000);

    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 90 * 60_000), {
        previousAt,
      }),
    ).rejects.toThrow('redis timeout');

    // Never jobless: the composer id is live again at the previous time.
    expect(added).toHaveLength(1);
    expect(added[0].jobId).toBe('composer-publish-p1');
    expect(added[0].delay).toBeGreaterThan(19 * 60_000);
    expect(added[0].delay).toBeLessThanOrEqual(20 * 60_000);
    expect(calls).not.toContain('write-jobId');
  });

  it('without previousAt the old job goes back at the time the row had', async () => {
    const { svc, added } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      addFailures: 1,
    });
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 90 * 60_000)),
    ).rejects.toThrow('redis timeout');
    expect(added[0].delay).toBeGreaterThan(29 * 60_000);
    expect(added[0].delay).toBeLessThanOrEqual(30 * 60_000);
  });

  it('when putting the old job back fails too, it logs an error and still throws', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { svc, added } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      addFailures: 2,
    });
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 90 * 60_000)),
    ).rejects.toThrow('redis timeout');
    expect(added).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('has NO publish job'),
    );
    error.mockRestore();
  });

  it('a failed job id write is retried once and keeps the new time', async () => {
    const { svc, calls, sets } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      jobIdWriteFailures: 1,
    });
    const at = new Date(Date.now() + 60 * 60_000);
    await expect(svc.moveTo('ws-1', 'p1', at)).resolves.toBe('moved');
    expect(calls.slice(-2)).toEqual(['write-jobId-failed', 'write-jobId']);
    // The time was written once, never rewound.
    expect(sets.filter((v) => 'scheduledAt' in v)).toEqual([
      { scheduledAt: at },
    ]);
  });

  it('a job id write that fails twice is logged, not thrown: the live job is at the new time', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { svc, sets } = make({
      row: { jobId: null, scheduledAt: OLD_AT },
      jobIdWriteFailures: 2,
    });
    const at = new Date(Date.now() + 60 * 60_000);
    await expect(svc.moveTo('ws-1', 'p1', at)).resolves.toBe('moved');
    expect(sets.filter((v) => 'scheduledAt' in v)).toEqual([
      { scheduledAt: at },
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not be recorded'),
    );
    error.mockRestore();
  });
});

describe('WorkspaceTimezoneMoveService.moveExisting: lock, check, then write', () => {
  /**
   * A db whose transaction records the order of what happens in it. The
   * channel read answers `channels`; the post read answers `postCount`
   * scheduled posts at 09:00 Karachi.
   */
  function make(opts: {
    jobState?: string | null;
    queueDown?: boolean;
    postCount?: number;
  }) {
    const calls: string[] = [];
    const posts = Array.from({ length: opts.postCount ?? 0 }, (_, i) => ({
      id: `p${i}`,
      scheduledAt: KARACHI_9AM,
      targets: [target('1')],
    }));
    let reads = 0;
    const tx = {
      execute: jest.fn(() => {
        calls.push('lock');
        return Promise.resolve();
      }),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => {
            reads += 1;
            calls.push(reads === 1 ? 'read-channels' : 'read-posts');
            return Promise.resolve(
              reads === 1 ? [{ id: 1, timezone: 'Asia/Karachi' }] : posts,
            );
          }),
        })),
      })),
      update: jest.fn(() => {
        calls.push('update');
        return {
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([]) }),
          }),
        };
      }),
    };
    const db = {
      transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const queue = {
      getJob: jest.fn(() => {
        calls.push('check');
        if (opts.queueDown) return Promise.reject(new Error('redis down'));
        return Promise.resolve(
          opts.jobState
            ? {
                getState: () => Promise.resolve(opts.jobState),
                remove: () => Promise.resolve(),
              }
            : undefined,
        );
      }),
      add: jest.fn(() => {
        calls.push('enqueue');
        return Promise.resolve({ id: 'tz-move-ws-1' });
      }),
    };
    const service = new WorkspaceTimezoneMoveService(
      db as never,
      { moveTo: jest.fn() } as never,
      queue as never,
    );
    const writeFirst = jest.fn(() => {
      calls.push('writeFirst');
      return Promise.resolve();
    });
    return { service, calls, writeFirst, tx, queue };
  }

  it.each(['waiting', 'delayed', 'active'])(
    '409 while the last move is %s, before writeFirst or any update',
    async (jobState) => {
      const { service, calls, writeFirst, tx } = make({ jobState });
      const err = await service
        .moveExisting('ws-1', 'Asia/Karachi', 'America/New_York', {
          writeFirst,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'TIMEZONE_MOVE_IN_PROGRESS',
      });
      expect(writeFirst).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
      expect(calls[0]).toBe('lock');
    },
  );

  it('takes the lock, checks, then writes the row before the channels', async () => {
    const { service, calls, writeFirst } = make({ jobState: 'completed' });
    await service.moveExisting('ws-1', 'Asia/Karachi', 'America/New_York', {
      writeFirst,
    });
    expect(calls.slice(0, 4)).toEqual([
      'lock',
      'read-channels',
      'read-posts',
      'check',
    ]);
    expect(calls.indexOf('writeFirst')).toBeGreaterThan(
      calls.lastIndexOf('check'),
    );
    expect(calls.indexOf('update')).toBeGreaterThan(
      calls.indexOf('writeFirst'),
    );
  });

  it('inline: an unreachable queue only warns, the move goes on', async () => {
    const { service, writeFirst } = make({ queueDown: true, postCount: 1 });
    await expect(
      service.moveExisting('ws-1', 'Asia/Karachi', 'America/New_York', {
        writeFirst,
      }),
    ).resolves.toMatchObject({ queued: false });
    expect(writeFirst).toHaveBeenCalled();
  });

  it('a planned post re-timed before its write counts as unmoved', async () => {
    // The fake write matches no row: the post no longer holds its `from`.
    const { service } = make({ jobState: null, postCount: 2 });
    await expect(
      service.moveExisting('ws-1', 'Asia/Karachi', 'America/New_York'),
    ).resolves.toEqual({
      movedChannels: 0,
      rescheduledPosts: 0,
      queued: false,
      unmovedPosts: 2,
    });
  });

  it('queued: an unreachable queue refuses the move before any write', async () => {
    const { service, writeFirst, tx, queue } = make({
      queueDown: true,
      postCount: TZ_MOVE_INLINE_LIMIT + 1,
    });
    await expect(
      service.moveExisting('ws-1', 'Asia/Karachi', 'America/New_York', {
        writeFirst,
      }),
    ).rejects.toThrow('redis down');
    expect(writeFirst).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('WorkspaceTimezoneMoveProcessor', () => {
  it('hands the job data to the service', async () => {
    const processQueued = jest.fn().mockResolvedValue(7);
    const processor = new WorkspaceTimezoneMoveProcessor({
      processQueued,
    } as unknown as WorkspaceTimezoneMoveService);
    const data: TimezoneMoveJob = {
      workspaceId: 'ws-1',
      fromZone: 'Asia/Karachi',
      toZone: 'America/New_York',
      channelZones: { '1': 'Asia/Karachi' },
      posts: [
        {
          id: 'p1',
          from: KARACHI_9AM.toISOString(),
          to: NEW_YORK_9AM.toISOString(),
        },
      ],
    };

    await expect(
      processor.process({
        data,
        timestamp: 1_700_000_000_000,
      } as Job<TimezoneMoveJob>),
    ).resolves.toBe(7);
    expect(processQueued).toHaveBeenCalledWith(data);
  });
});
