/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';
import { ComposerSchedulingService } from './composer-scheduling.service';

/**
 * "Repeat this post" travels with the schedule request and is stored on the
 * post with the series state the server owns; without it, nothing about the
 * stored row changes.
 */
function make(existing: any[]) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          // loadWorkspaceTimezone awaits `where` directly; the post lookup
          // calls `.limit()`.
          const zone = Promise.resolve([{ timezone: 'Asia/Karachi' }]);
          return Object.assign(zone, { limit: async () => existing });
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  const queue = {
    getJob: jest.fn(async () => null),
    add: jest.fn(async (_n: string, _d: any, opts: any) => ({
      id: opts.jobId,
    })),
  };
  const svc = new ComposerSchedulingService(
    db as any,
    queue as any,
    { syncPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit: jest.fn(async () => undefined) } as any,
  );
  return { svc, inserts, updates, queue };
}

// Thu 2026-10-15 9:30 AM Karachi; the tests run before it (Date mocked).
const AT = '2026-10-15T04:30:00.000Z';

const dto = (over: any = {}) => ({
  draftId: 'd1',
  scheduledAt: AT,
  base: { text: 'caption', mediaItems: [], hashtags: [], mentions: [] },
  channels: [{ channelId: '7', platform: 'facebook' }],
  ...over,
});

const RULE = {
  freq: 'weekly',
  interval: 1,
  ends: { type: 'after', count: 4 },
};

beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-10-14T00:00:00Z') });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('ComposerSchedulingService with a repeat rule', () => {
  it('stores the rule with a new series on a new post', async () => {
    const { svc, inserts } = make([]);
    await svc.schedule(
      'w1',
      'u1',
      dto({
        recurrence: { ...RULE, seriesId: 'forged', occurrence: 9 },
      }),
    );
    expect(inserts[0].metadata.schedule).toEqual({
      mode: 'all_same_time',
      scheduleAt: AT,
      recurrence: {
        ...RULE,
        seriesId: 'd1',
        occurrence: 1,
        anchorDate: '2026-10-15',
        time: '09:30',
      },
    });
  });

  it('keeps a post in its series when it is scheduled again', async () => {
    const { svc, updates } = make([
      {
        id: 'd1',
        status: 'scheduled',
        metadata: {
          schedule: {
            recurrence: {
              ...RULE,
              seriesId: 's0',
              occurrence: 3,
              anchorDate: '2026-10-01',
              time: '09:30',
            },
          },
        },
      },
    ]);
    await svc.schedule('w1', 'u1', dto({ recurrence: RULE }));
    const row = updates.find((u) => u.metadata);
    expect(row.metadata.schedule.recurrence).toMatchObject({
      seriesId: 's0',
      occurrence: 3,
      anchorDate: '2026-10-15',
    });
  });

  it('refuses a bad rule before writing or enqueueing anything', async () => {
    const { svc, inserts, updates, queue } = make([]);
    await expect(
      svc.schedule(
        'w1',
        'u1',
        dto({ recurrence: { freq: 'hourly', interval: 1 } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('without a rule writes no schedule key — the row is as before', async () => {
    const { svc, inserts } = make([]);
    await svc.schedule('w1', 'u1', dto());
    expect(inserts[0].metadata).not.toHaveProperty('schedule');
  });

  it('a null rule is the same as none', async () => {
    const { svc, inserts } = make([]);
    await svc.schedule('w1', 'u1', dto({ recurrence: null }));
    expect(inserts[0].metadata).not.toHaveProperty('schedule');
  });
});
