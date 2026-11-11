/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ComposerSchedulingService } from './composer-scheduling.service';

/**
 * D1, write side: scheduling keeps every per-platform field (X's thread and
 * poll included) in that platform's own `platformContent` entry and never
 * copies one into the row's shared metadata, where the scheduled publish
 * would hand it to every channel.
 *
 * D5/S2: a template's `{{blank}}` is refused before anything is written.
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

const THREAD = [{ text: 'x one' }, { text: 'x two' }];
const POLL = { options: ['Hot', 'Iced'], durationMinutes: 60 };

const dto = (over: Record<string, unknown> = {}) => ({
  draftId: 'd1',
  scheduledAt: T1,
  base: { text: 'caption', mediaItems: [], hashtags: [], mentions: [] },
  perPlatform: {
    twitter: {
      inheritsFromBase: true,
      overrides: {},
      platformSpecific: { postType: 'thread', thread: THREAD, poll: POLL },
    },
    bluesky: { inheritsFromBase: true, overrides: {}, platformSpecific: {} },
  },
  channels: [
    { channelId: '1', platform: 'twitter' },
    { channelId: '2', platform: 'bluesky' },
    { channelId: '3', platform: 'mastodon' },
  ],
  ...over,
});

beforeAll(() => {
  jest.useFakeTimers({ now: NOW });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('ComposerSchedulingService - shared metadata holds shared keys only', () => {
  it("one time: X's thread and poll stay in X's own fields", async () => {
    const { svc, inserts } = make();
    await svc.schedule('w1', 'u1', dto() as any);

    expect(inserts).toHaveLength(1);
    const [row] = inserts;
    expect(row.metadata.thread).toBeUndefined();
    expect(row.metadata.poll).toBeUndefined();
    expect(row.platformContent.twitter.platformSpecific.thread).toEqual(THREAD);
    expect(row.platformContent.twitter.platformSpecific.poll).toEqual(POLL);
  });

  it("a time per channel: no sibling carries X's thread in its shared metadata", async () => {
    const { svc, inserts } = make();
    await svc.schedule(
      'w1',
      'u1',
      dto({
        scheduleMode: 'per_channel',
        channels: [
          { channelId: '1', platform: 'twitter', scheduleAt: T1 },
          { channelId: '2', platform: 'bluesky', scheduleAt: T1 },
          { channelId: '3', platform: 'mastodon', scheduleAt: T2 },
        ],
      }) as any,
    );

    expect(inserts).toHaveLength(2);
    for (const row of inserts) {
      expect(row.metadata.thread).toBeUndefined();
      expect(row.metadata.poll).toBeUndefined();
    }
  });
});

describe('ComposerSchedulingService - unfilled template blanks', () => {
  it.each([
    ['the shared caption', { base: { text: 'Meet our {{product_name}}', mediaItems: [] } }],
    [
      'a channel caption',
      {
        perPlatform: {
          bluesky: {
            inheritsFromBase: false,
            overrides: { text: 'Out {{ date }}' },
            platformSpecific: {},
          },
        },
      },
    ],
    [
      'a thread post',
      {
        perPlatform: {
          twitter: {
            inheritsFromBase: true,
            overrides: {},
            platformSpecific: {
              postType: 'thread',
              thread: [{ text: 'one' }, { text: 'two {{cta}}' }],
            },
          },
        },
      },
    ],
  ])('refuses one in %s, before anything is written or queued', async (_l, over) => {
    const { svc, inserts, updates, queue } = make();
    await expect(svc.schedule('w1', 'u1', dto(over) as any)).rejects.toThrow(
      BadRequestException,
    );
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('schedules single braces, which are wordings, not blanks', async () => {
    const { svc, inserts } = make();
    await svc.schedule(
      'w1',
      'u1',
      dto({ base: { text: '{Hot|Iced} latte', mediaItems: [] } }) as any,
    );
    expect(inserts).toHaveLength(1);
  });
});
