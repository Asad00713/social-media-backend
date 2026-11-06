/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { RepeatPostsService } from './repeat-posts.service';
import { seriesPostId } from '../lib/recurrence';

const AT = new Date('2026-10-15T04:30:00Z'); // Thu 9:30 AM Karachi
const NOW = new Date('2026-10-15T04:30:05Z');
const NEXT_ID = seriesPostId('s1', 2);

const recurrence = (over: any = {}) => ({
  freq: 'weekly',
  interval: 1,
  ends: { type: 'never' },
  seriesId: 's1',
  occurrence: 1,
  anchorDate: '2026-10-15',
  time: '09:30',
  ...over,
});

const post = (over: any = {}): any => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  content: 'Iced latte is back',
  mediaItems: [{ url: 'https://cdn/x.jpg', type: 'image' }],
  platformContent: { instagram: { platformSpecific: { frameNote: 'n' } } },
  targets: [
    {
      channelId: '7',
      platform: 'instagram',
      status: 'published',
      platformPostId: 'ig-1',
      publishStatus: 'published',
    },
  ],
  status: 'scheduled',
  scheduledAt: AT,
  jobId: 'composer-publish-p1',
  metadata: {
    source: 'composer',
    hashtags: ['#a'],
    campaignId: 'c1',
    schedule: {
      mode: 'all_same_time',
      scheduleAt: AT.toISOString(),
      recurrence: recurrence(),
    },
  },
  ...over,
});

function make(opts: { inserted?: boolean; existing?: any } = {}) {
  const inserts: any[] = [];
  let selects = 0;
  const db = {
    // First select: workspace zone (loadWorkspaceTimezone). Second: the
    // existing next post, read only when the insert hit a conflict.
    select: jest.fn(() => ({
      from: () => ({
        where: () => {
          selects += 1;
          if (selects === 1)
            return Promise.resolve([{ timezone: 'Asia/Karachi' }]);
          return { limit: async () => (opts.existing ? [opts.existing] : []) };
        },
      }),
    })),
    insert: jest.fn(() => ({
      values: (v: any) => {
        inserts.push(v);
        return {
          onConflictDoNothing: () => ({
            returning: async () =>
              opts.inserted === false ? [] : [{ id: v.id }],
          }),
        };
      },
    })),
  };
  const queue = { add: jest.fn(async () => ({})) };
  const calendar = { syncPost: jest.fn(async () => undefined) };
  const svc = new RepeatPostsService(db as any, queue as any, calendar as any);
  return { svc, db, queue, calendar, inserts };
}

describe('RepeatPostsService.ensureNext', () => {
  it('does nothing for a post that does not repeat', async () => {
    const { svc, db, queue } = make();
    const plain = post({ metadata: { source: 'composer' } });
    await expect(svc.ensureNext(plain, NOW)).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('inserts the next post as a fresh scheduled copy, a week on at the same time', async () => {
    const { svc, inserts } = make();
    await expect(svc.ensureNext(post(), NOW)).resolves.toBe(NEXT_ID);
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row).toMatchObject({
      id: NEXT_ID,
      workspaceId: 'w1',
      createdById: 'u1',
      content: 'Iced latte is back',
      status: 'scheduled',
      scheduledAt: new Date('2026-10-22T04:30:00Z'),
      jobId: `composer-publish-${NEXT_ID}`,
      publishedAt: null,
      lastError: null,
    });
    expect(row.platformContent).toEqual(post().platformContent);
    // Nothing of the published post's outcome is carried over.
    expect(row.targets).toEqual([
      {
        channelId: '7',
        platform: 'instagram',
        status: 'draft',
        publishStatus: 'queued',
        retryCount: 0,
      },
    ]);
    // Campaign membership is not inherited; the rule moves one place on.
    expect(row.metadata.campaignId).toBeUndefined();
    expect(row.metadata.hashtags).toEqual(['#a']);
    expect(row.metadata.schedule).toEqual({
      mode: 'all_same_time',
      scheduleAt: '2026-10-22T04:30:00.000Z',
      recurrence: recurrence({ occurrence: 2 }),
    });
  });

  it('enqueues the next post on its own fixed job id, delayed to its time', async () => {
    const { svc, queue, calendar } = make();
    await svc.ensureNext(post(), NOW);
    expect(queue.add).toHaveBeenCalledWith(
      'publish',
      { postId: NEXT_ID },
      {
        jobId: `composer-publish-${NEXT_ID}`,
        delay: new Date('2026-10-22T04:30:00Z').getTime() - NOW.getTime(),
        attempts: 3,
      },
    );
    expect(calendar.syncPost).toHaveBeenCalledWith(NEXT_ID);
  });

  it('a retry finds the row it created and only re-adds the same job', async () => {
    const { svc, queue, inserts } = make({
      inserted: false,
      existing: { status: 'scheduled', jobId: `composer-publish-${NEXT_ID}` },
    });
    await svc.ensureNext(post(), NOW);
    expect(inserts).toHaveLength(1); // the conflicting insert, a no-op
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((queue.add.mock.calls[0] as any[])[2].jobId).toBe(
      `composer-publish-${NEXT_ID}`,
    );
  });

  it('does not re-enqueue a next post someone has moved or unscheduled', async () => {
    for (const existing of [
      { status: 'scheduled', jobId: 'post-x-123' },
      { status: 'draft', jobId: null },
      undefined,
    ]) {
      const { svc, queue } = make({ inserted: false, existing });
      await svc.ensureNext(post(), NOW);
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('creates nothing once the series has ended', async () => {
    const { svc, db, queue } = make();
    const last = post({
      metadata: {
        schedule: {
          recurrence: recurrence({
            occurrence: 4,
            ends: { type: 'after', count: 4 },
          }),
        },
      },
    });
    await expect(svc.ensureNext(last, NOW)).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores a malformed stored rule', async () => {
    const { svc, db } = make();
    const bad = post({
      metadata: { schedule: { recurrence: recurrence({ interval: 0 }) } },
    });
    await expect(svc.ensureNext(bad, NOW)).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
