/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ComposerSchedulingService } from './composer-scheduling.service';
import {
  assertApprovedFor,
  contentFingerprint,
} from '../../lib/draft-approval';
import {
  PER_CHANNEL_WITH_REPEAT,
  SCHEDULE_GROUP_KEY,
} from '../lib/per-channel-schedule';

/**
 * "Different time for each channel" (#43): channels at different times are
 * split into sibling posts, one per distinct time, each with its own job.
 */
function make(existing: any[] = [], opts: { queueFullOn?: string } = {}) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
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
    add: jest.fn(async (_n: string, _d: any, o: any) => ({ id: o.jobId })),
  };
  const enforceQueueLimit = jest.fn(async (_ws: string, ids: string[]) => {
    if (opts.queueFullOn && ids.includes(opts.queueFullOn)) {
      throw new ForbiddenException('Scheduling queue full');
    }
  });
  const versions = { record: jest.fn(async () => undefined) };
  const svc = new ComposerSchedulingService(
    db as any,
    queue as any,
    { syncPost: jest.fn(async () => undefined) } as any,
    { enforceQueueLimit } as any,
    versions as any,
  );
  return { svc, inserts, updates, queue, enforceQueueLimit, versions };
}

const NOW = new Date('2026-10-14T00:00:00Z');
const T1 = '2026-10-15T04:30:00.000Z';
const T2 = '2026-10-16T09:00:00.000Z';

const THREAD = [{ text: 'one' }, { text: 'two' }];
const PER_PLATFORM = {
  facebook: {
    inheritsFromBase: false,
    overrides: { text: 'fb caption' },
    platformSpecific: { firstComment: 'fb first' },
  },
  twitter: {
    inheritsFromBase: true,
    overrides: {},
    platformSpecific: { thread: THREAD },
  },
  linkedin: {
    inheritsFromBase: true,
    overrides: {},
    platformSpecific: { firstComment: 'li first' },
  },
};

const BASE = {
  text: 'caption',
  mediaItems: [{ id: 'm1', type: 'image', url: 'u', sizeBytes: 1 }],
  hashtags: [],
  mentions: [],
};

/** Facebook and LinkedIn at T1, X at T2 — listed with the later one first. */
const SPLIT = () => ({
  draftId: 'd1',
  scheduledAt: T1,
  scheduleMode: 'per_channel',
  base: BASE,
  perPlatform: PER_PLATFORM,
  labels: ['launch'],
  channels: [
    { channelId: '8', platform: 'twitter', scheduleAt: T2 },
    { channelId: '7', platform: 'facebook', scheduleAt: T1 },
    { channelId: '9', platform: 'linkedin', scheduleAt: T1 },
  ],
});

const ids = (row: any) => row.targets.map((t: any) => t.channelId);

beforeAll(() => {
  jest.useFakeTimers({ now: NOW });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('ComposerSchedulingService — a time per channel', () => {
  it('one distinct time takes the one-row path, unchanged', async () => {
    const same = make();
    await same.svc.schedule('w1', 'u1', {
      ...SPLIT(),
      channels: SPLIT().channels.map((c) => ({ ...c, scheduleAt: T1 })),
    } as any);
    const plain = make();
    await plain.svc.schedule('w1', 'u1', {
      ...SPLIT(),
      scheduleMode: undefined,
      channels: SPLIT().channels.map(({ channelId, platform }) => ({
        channelId,
        platform,
      })),
    } as any);

    expect(same.inserts).toHaveLength(1);
    expect(same.inserts).toEqual(plain.inserts);
    expect(same.inserts[0].id).toBe('d1');
    expect(same.inserts[0].metadata[SCHEDULE_GROUP_KEY]).toBeUndefined();
    expect(same.queue.add).toHaveBeenCalledTimes(1);
    expect(same.queue.add.mock.calls[0][2].jobId).toBe('composer-publish-d1');
  });

  it('without per_channel a channel time is ignored, as before', async () => {
    const { svc, inserts, queue } = make();
    await svc.schedule('w1', 'u1', {
      ...SPLIT(),
      scheduleMode: undefined,
    } as any);
    expect(inserts).toHaveLength(1);
    expect(ids(inserts[0])).toEqual(['8', '7', '9']);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('three channels at two times become two rows with their own channels and jobs', async () => {
    const { svc, inserts, queue, enforceQueueLimit } = make();
    const result = await svc.schedule('w1', 'u1', SPLIT() as any);

    expect(inserts).toHaveLength(2);
    const [first, second] = inserts;

    // The earliest keeps the draft's id; the other is new.
    expect(first.id).toBe('d1');
    expect(second.id).not.toBe('d1');
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(ids(first)).toEqual(['7', '9']);
    expect(ids(second)).toEqual(['8']);
    expect(first.scheduledAt.toISOString()).toBe(T1);
    expect(second.scheduledAt.toISOString()).toBe(T2);

    // Each holds only its own platforms' content.
    expect(Object.keys(first.platformContent).sort()).toEqual([
      'facebook',
      'linkedin',
    ]);
    expect(first.platformContent.facebook.platformSpecific.firstComment).toBe(
      'fb first',
    );
    expect(Object.keys(second.platformContent)).toEqual(['twitter']);
    // X's thread stays X's: in its own fields, never the shared metadata.
    expect(first.metadata.thread).toBeUndefined();
    expect(second.metadata.thread).toBeUndefined();
    expect(second.platformContent.twitter.platformSpecific.thread).toEqual(
      THREAD,
    );
    // Shared content goes to both.
    expect(first.mediaItems).toEqual(BASE.mediaItems);
    expect(second.mediaItems).toEqual(BASE.mediaItems);
    expect(first.content).toBe('caption');
    expect(second.metadata.labels).toEqual(['launch']);
    expect(first.metadata.labels).toEqual(['launch']);

    // One family.
    const group = first.metadata[SCHEDULE_GROUP_KEY];
    expect(group).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.metadata[SCHEDULE_GROUP_KEY]).toBe(group);

    // One job each, at its own time.
    expect(queue.add).toHaveBeenCalledTimes(2);
    const [job1, job2] = queue.add.mock.calls;
    expect(job1[1]).toEqual({ postId: 'd1' });
    expect(job1[2].jobId).toBe('composer-publish-d1');
    expect(job1[2].delay).toBe(new Date(T1).getTime() - NOW.getTime());
    expect(job2[1]).toEqual({ postId: second.id });
    expect(job2[2].jobId).toBe(`composer-publish-${second.id}`);
    expect(job2[2].delay).toBe(new Date(T2).getTime() - NOW.getTime());

    // The queue ceiling, per sibling.
    expect(enforceQueueLimit.mock.calls.map((c) => c[1])).toEqual([
      ['7', '9'],
      ['8'],
    ]);

    expect(result).toEqual({
      postId: 'd1',
      scheduledAt: T1,
      status: 'scheduled',
      siblings: [
        { postId: 'd1', scheduledAt: T1, channelIds: ['7', '9'] },
        { postId: second.id, scheduledAt: T2, channelIds: ['8'] },
      ],
      scheduleGroupId: group,
    });
  });

  it('updates the stored draft for the first sibling and inserts the rest', async () => {
    const stored = {
      id: 'd1',
      status: 'draft',
      createdById: 'author',
      metadata: { campaignId: null },
      targets: [],
    };
    const { svc, inserts, updates, versions } = make([stored]);
    await svc.schedule('w1', 'u1', SPLIT() as any);

    const rowUpdate = updates.find((u) => u.targets);
    expect(ids(rowUpdate)).toEqual(['7', '9']);
    expect(rowUpdate.status).toBe('scheduled');
    expect(inserts).toHaveLength(1);
    expect(ids(inserts[0])).toEqual(['8']);
    // The new sibling belongs to the draft's author, not the scheduler.
    expect(inserts[0].createdById).toBe('author');
    // Each sibling's own version.
    expect(versions.record.mock.calls.map((c: any[]) => c[0])).toEqual([
      'd1',
      inserts[0].id,
    ]);
  });

  it('a sibling re-split keeps its family id', async () => {
    const stored = {
      id: 'd1',
      status: 'draft',
      metadata: { [SCHEDULE_GROUP_KEY]: 'g-old' },
      targets: [],
    };
    const { svc, inserts } = make([stored]);
    const result = await svc.schedule('w1', 'u1', SPLIT() as any);
    expect(result.scheduleGroupId).toBe('g-old');
    expect(inserts[0].metadata[SCHEDULE_GROUP_KEY]).toBe('g-old');
  });

  it('a re-scheduled sibling stays in its family on the one-row path', async () => {
    const stored = {
      id: 'd1',
      status: 'scheduled',
      metadata: { [SCHEDULE_GROUP_KEY]: 'g-old' },
      targets: [],
    };
    const { svc, updates } = make([stored]);
    await svc.schedule('w1', 'u1', {
      ...SPLIT(),
      scheduleMode: undefined,
    } as any);
    expect(updates.find((u) => u.metadata).metadata[SCHEDULE_GROUP_KEY]).toBe(
      'g-old',
    );
  });

  it('does not count a slot the scheduled draft already holds', async () => {
    const stored = {
      id: 'd1',
      status: 'scheduled',
      metadata: {},
      targets: [{ channelId: '7' }, { channelId: '8' }],
    };
    const { svc, enforceQueueLimit } = make([stored]);
    await svc.schedule('w1', 'u1', SPLIT() as any);
    expect(enforceQueueLimit.mock.calls.map((c) => c[1])).toEqual([['9'], []]);
  });

  describe('approval', () => {
    const approval = (fingerprint: string | null) => ({
      required: true,
      requestedById: 'writer',
      requestedAt: '2026-10-01T00:00:00Z',
      approvedById: fingerprint ? 'boss' : null,
      approvedAt: fingerprint ? '2026-10-02T00:00:00Z' : null,
      approvedFingerprint: fingerprint,
    });
    const wholeFingerprint = contentFingerprint({
      content: BASE.text,
      mediaItems: BASE.mediaItems,
      platformContent: PER_PLATFORM,
      targets: SPLIT().channels,
    });

    it('refuses an unapproved post before any write or job', async () => {
      const { svc, inserts, updates, queue } = make([
        { id: 'd1', status: 'draft', metadata: { approval: approval(null) } },
      ]);
      await expect(svc.schedule('w1', 'u1', SPLIT() as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('refuses content changed since it was approved', async () => {
      const { svc, inserts, queue } = make([
        {
          id: 'd1',
          status: 'draft',
          metadata: { approval: approval('stale') },
        },
      ]);
      await expect(
        svc.schedule('w1', 'u1', SPLIT() as any),
      ).rejects.toMatchObject({ response: { code: 'APPROVAL_STALE' } });
      expect(inserts).toHaveLength(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('each approved sibling carries a grant for exactly its own content', async () => {
      const { svc, inserts, updates } = make([
        {
          id: 'd1',
          status: 'draft',
          metadata: { approval: approval(wholeFingerprint) },
          targets: [],
        },
      ]);
      await svc.schedule('w1', 'u1', SPLIT() as any);
      const rows = [updates.find((u) => u.targets), inserts[0]];
      for (const row of rows) {
        const part = {
          content: row.content,
          mediaItems: row.mediaItems,
          platformContent: row.platformContent,
          targets: row.targets,
        };
        expect(row.metadata.approval.approvedById).toBe('boss');
        expect(row.metadata.approval.approvedFingerprint).toBe(
          contentFingerprint(part),
        );
        // Re-scheduling that sibling unchanged later still passes.
        expect(() => assertApprovedFor(row.metadata, part)).not.toThrow();
      }
      expect(rows[0].metadata.approval.approvedFingerprint).not.toBe(
        rows[1].metadata.approval.approvedFingerprint,
      );
    });
  });

  it('refuses per-channel times with a repeat', async () => {
    const { svc, inserts, queue } = make();
    await expect(
      svc.schedule('w1', 'u1', {
        ...SPLIT(),
        recurrence: { freq: 'weekly', interval: 1, ends: { type: 'never' } },
      } as any),
    ).rejects.toThrow(PER_CHANNEL_WITH_REPEAT);
    expect(inserts).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a channel without a time', async () => {
    const { svc, inserts, queue } = make();
    const dto = SPLIT();
    delete (dto.channels[1] as any).scheduleAt;
    await expect(svc.schedule('w1', 'u1', dto as any)).rejects.toThrow(
      /Channel 7 has no time/,
    );
    expect(inserts).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a channel time in the past', async () => {
    const { svc, inserts, queue } = make();
    const dto = SPLIT();
    dto.channels[0].scheduleAt = '2026-10-13T00:00:00.000Z';
    await expect(svc.schedule('w1', 'u1', dto as any)).rejects.toThrow(
      /channel 8 must be at least 5 seconds in the future/,
    );
    expect(inserts).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a full queue on any sibling leaves nothing half-scheduled', async () => {
    const { svc, inserts, updates, queue } = make([], { queueFullOn: '8' });
    await expect(svc.schedule('w1', 'u1', SPLIT() as any)).rejects.toThrow(
      ForbiddenException,
    );
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
