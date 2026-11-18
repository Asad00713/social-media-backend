import { ConflictException } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { PostTarget } from '../drizzle/schema/posts.schema';
import { PostRescheduleService } from '../posts/services/post-reschedule.service';
import { WorkspaceTimezoneMoveProcessor } from './workspace-timezone-move.processor';
import {
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
  function make(
    row: { jobId: string | null } | undefined,
    failRemoveOf?: string,
  ) {
    const sets: Record<string, unknown>[] = [];
    const db = {
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: jest.fn(() => ({
              returning: jest.fn(() => Promise.resolve(row ? [row] : [])),
              then: (resolve: (v: unknown) => void) => resolve(undefined),
            })),
          };
        }),
      })),
    };
    const removed: string[] = [];
    const queue = {
      getJob: jest.fn((id: string) =>
        Promise.resolve({
          remove: jest.fn(() => {
            if (id === failRemoveOf) {
              return Promise.reject(new Error('job is locked'));
            }
            removed.push(id);
            return Promise.resolve();
          }),
        }),
      ),
      add: jest.fn((_name: string, _data: unknown, opts: { jobId: string }) =>
        Promise.resolve({ id: opts.jobId }),
      ),
    };
    const svc = new PostRescheduleService(db as never, queue as never);
    return { svc, sets, removed, queue };
  }

  it('moves the row, swaps both jobs for composer-publish-<id> and records it', async () => {
    const { svc, sets, removed, queue } = make({ jobId: 'post-p1-old' });
    const at = new Date(Date.now() + 60 * 60_000);

    await expect(svc.moveTo('ws-1', 'p1', at)).resolves.toBe('moved');

    expect(sets[0]).toEqual({ scheduledAt: at });
    expect(removed).toEqual(['composer-publish-p1', 'post-p1-old']);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { jobId: string; delay: number; attempts: number },
    ];
    expect(name).toBe('publish');
    expect(data).toEqual({ postId: 'p1' });
    expect(opts.jobId).toBe('composer-publish-p1');
    expect(opts.jobId).not.toContain(':');
    expect(opts.attempts).toBe(3);
    expect(opts.delay).toBeGreaterThan(59 * 60_000);
    expect(sets[1]).toEqual({ jobId: 'composer-publish-p1' });
  });

  it('a past instant gets delay 0', async () => {
    const { svc, queue } = make({ jobId: null });
    await svc.moveTo('ws-1', 'p1', new Date(Date.now() - 1000));
    const opts = queue.add.mock.calls[0][2] as unknown as { delay: number };
    expect(opts.delay).toBe(0);
  });

  it('touches no job of a post that is no longer movable', async () => {
    const { svc, queue } = make(undefined);
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(), { ifScheduledAt: new Date() }),
    ).resolves.toBe('not-movable');
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws and adds nothing when the old composer job cannot be removed', async () => {
    // Adding the same id would hand back the OLD job at its OLD delay.
    const { svc, queue } = make({ jobId: null }, 'composer-publish-p1');
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 60_000)),
    ).rejects.toThrow('composer-publish-p1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a recorded legacy job that cannot be removed is only logged', async () => {
    const { svc, queue } = make({ jobId: 'post-p1-old' }, 'post-p1-old');
    await expect(
      svc.moveTo('ws-1', 'p1', new Date(Date.now() + 60_000)),
    ).resolves.toBe('moved');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceTimezoneMoveService.assertNoMoveInProgress', () => {
  function make(state: string | null, fail = false) {
    const queue = {
      getJob: jest.fn((id: string) => {
        if (fail) return Promise.reject(new Error('redis down'));
        expect(id).toBe('tz-move-ws-1');
        return Promise.resolve(
          state ? { getState: () => Promise.resolve(state) } : undefined,
        );
      }),
    };
    return new WorkspaceTimezoneMoveService(
      {} as never,
      {} as never,
      queue as never,
    );
  }

  it('409 TIMEZONE_MOVE_IN_PROGRESS while the job waits or runs', async () => {
    for (const state of ['waiting', 'delayed', 'active']) {
      const err = await make(state)
        .assertNoMoveInProgress('ws-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'TIMEZONE_MOVE_IN_PROGRESS',
      });
    }
  });

  it('passes with no job, a finished one, or no queue to ask', async () => {
    await expect(make(null).assertNoMoveInProgress('ws-1')).resolves.toBe(
      undefined,
    );
    await expect(
      make('completed').assertNoMoveInProgress('ws-1'),
    ).resolves.toBe(undefined);
    await expect(make(null, true).assertNoMoveInProgress('ws-1')).resolves.toBe(
      undefined,
    );
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
