/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- test doubles are loosely typed */
import { QueueSlotsService, takenMinuteKeys } from './queue-slots.service';
import { PLANNER_PREF_DEFAULTS } from '../lib/planner-prefs';

const NOW = new Date('2026-11-04T10:00:00Z'); // Wed 15:00 Karachi

function makeDb(postRows: unknown[], timezone = 'Asia/Karachi') {
  let call = 0;
  return {
    select: jest.fn(() => ({
      from: () => ({
        // First select: the workspace zone. Second: the scheduled posts.
        where: async () => (call++ === 0 ? [{ timezone }] : postRows),
      }),
    })),
  };
}

function make(postRows: unknown[], slots = PLANNER_PREF_DEFAULTS.queueSlots) {
  const db = makeDb(postRows);
  const prefs = {
    get: jest.fn(async () => ({ ...PLANNER_PREF_DEFAULTS, queueSlots: slots })),
  };
  return { svc: new QueueSlotsService(db as any, prefs as any), db, prefs };
}

describe('takenMinuteKeys', () => {
  const at = new Date('2026-11-04T13:00:00Z');
  const row = (over: any = {}) => ({
    id: 'p1',
    scheduledAt: at,
    targets: [{ channelId: '7' }],
    ...over,
  });

  it('a post on one of the draft channels holds its minute', () => {
    expect(takenMinuteKeys([row()], { channelIds: ['7'] }).size).toBe(1);
  });

  it('a post on another channel does not', () => {
    expect(takenMinuteKeys([row()], { channelIds: ['8'] }).size).toBe(0);
  });

  it('with no channels picked, every scheduled post holds its minute', () => {
    expect(takenMinuteKeys([row()], { channelIds: [] }).size).toBe(1);
  });

  it('the draft itself never holds a slot against itself', () => {
    expect(
      takenMinuteKeys([row()], { channelIds: ['7'], excludePostId: 'p1' }).size,
    ).toBe(0);
  });

  it('numeric and string channel ids match', () => {
    expect(
      takenMinuteKeys([row({ targets: [{ channelId: 7 }] })], {
        channelIds: ['7'],
      }).size,
    ).toBe(1);
  });
});

describe('QueueSlotsService.get', () => {
  it('returns the first slot as both next free and top when nothing is scheduled', async () => {
    const { svc } = make([]);
    const out = await svc.get('w1', 'u1', { channelIds: ['7'] }, NOW);
    expect(out.timezone).toBe('Asia/Karachi');
    expect(out.nextFree).toBe('2026-11-04T13:00:00.000Z'); // Wed 18:00
    expect(out.top).toBe('2026-11-04T13:00:00.000Z');
  });

  it('skips a slot held on the same channel and withholds the top', async () => {
    const { svc } = make([
      {
        id: 'other',
        scheduledAt: new Date('2026-11-04T13:00:00Z'),
        targets: [{ channelId: '7' }],
      },
    ]);
    const out = await svc.get('w1', 'u1', { channelIds: ['7'] }, NOW);
    expect(out.nextFree).toBe('2026-11-05T04:00:00.000Z'); // Thu 09:00
    expect(out.top).toBeNull();
  });

  it('an empty queue offers nothing and does not query posts', async () => {
    const { svc, db } = make([], []);
    const out = await svc.get('w1', 'u1', { channelIds: [] }, NOW);
    expect(out).toEqual({
      timezone: 'Asia/Karachi',
      slots: [],
      nextFree: null,
      top: null,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("reads the caller's own preferences", async () => {
    const { svc, prefs } = make([]);
    await svc.get('w1', 'u1', { channelIds: [] }, NOW);
    expect(prefs.get).toHaveBeenCalledWith('u1', 'w1');
  });
});
