import {
  DEFAULT_QUEUE_SLOTS,
  MAX_QUEUE_SLOTS,
  minuteKey,
  pickQueueSlots,
  sanitizeQueueSlots,
  upcomingSlotInstants,
} from './queue-slots';

// Wed 2026-11-04 10:00 UTC = 15:00 in Karachi (UTC+5, no DST).
const NOW = new Date('2026-11-04T10:00:00Z');
const KHI = 'Asia/Karachi';

describe('sanitizeQueueSlots', () => {
  it('is null for anything but an array', () => {
    for (const v of [undefined, null, 'x', 3, {}]) {
      expect(sanitizeQueueSlots(v)).toBeNull();
    }
  });

  it('keeps an empty list (no queue) as empty, not as the default', () => {
    expect(sanitizeQueueSlots([])).toEqual([]);
  });

  it('drops invalid slots and duplicates, and sorts by week order', () => {
    expect(
      sanitizeQueueSlots([
        { weekday: 5, time: '18:00' },
        { weekday: 7, time: '09:00' },
        { weekday: 1, time: '24:00' },
        { weekday: 1.5, time: '09:00' },
        { weekday: 1, time: '9:00' },
        { weekday: 1, time: '09:00' },
        { weekday: 5, time: '18:00' },
        { weekday: 1, time: '08:30', extra: true },
      ]),
    ).toEqual([
      { weekday: 1, time: '08:30' },
      { weekday: 1, time: '09:00' },
      { weekday: 5, time: '18:00' },
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      weekday: i % 7,
      time: `${String(Math.floor(i / 7)).padStart(2, '0')}:00`,
    })).filter((s) => Number(s.time.slice(0, 2)) < 24);
    expect(sanitizeQueueSlots(many)!.length).toBe(MAX_QUEUE_SLOTS);
  });
});

describe('upcomingSlotInstants', () => {
  it('reads each slot as a wall-clock time in the workspace zone', () => {
    const out = upcomingSlotInstants(
      [{ weekday: 5, time: '18:00' }],
      KHI,
      NOW,
      7,
    );
    // Friday 6 PM Karachi = 13:00 UTC.
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-11-06T13:00:00.000Z',
    ]);
  });

  it('skips a slot that has already passed today, and one inside the lead time', () => {
    const slots = [
      { weekday: 3, time: '14:00' }, // passed (now 15:00)
      { weekday: 3, time: '15:01' }, // inside the 2-minute lead
      { weekday: 3, time: '15:05' },
    ];
    const out = upcomingSlotInstants(slots, KHI, NOW, 0);
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-11-04T10:05:00.000Z',
    ]);
  });

  it('returns every instant in the horizon, earliest first', () => {
    const out = upcomingSlotInstants(DEFAULT_QUEUE_SLOTS, KHI, NOW, 7);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].getTime()).toBeGreaterThan(out[i - 1].getTime());
    }
    // Wed 18:00, Thu x2, Fri x2, Mon x2, Tue x2, Wed 09:00 + 18:00 (day 7).
    expect(out[0].toISOString()).toBe('2026-11-04T13:00:00.000Z');
    expect(out.length).toBe(11);
  });

  it('keeps the wall time across a DST change', () => {
    // New York leaves DST on Sun 2026-11-01.
    const before = new Date('2026-10-28T12:00:00Z');
    const out = upcomingSlotInstants(
      [{ weekday: 1, time: '09:00' }],
      'America/New_York',
      before,
      7,
    );
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-11-02T14:00:00.000Z',
    ]);
  });

  it('skips a wall time that a DST jump removes', () => {
    // New York jumps 02:00 -> 03:00 on Sun 2027-03-14.
    const out = upcomingSlotInstants(
      [{ weekday: 0, time: '02:30' }],
      'America/New_York',
      new Date('2027-03-10T12:00:00Z'),
      6,
    );
    expect(out).toEqual([]);
  });

  it('treats an unknown zone as UTC', () => {
    const out = upcomingSlotInstants(
      [{ weekday: 5, time: '18:00' }],
      'Not/AZone',
      NOW,
      7,
    );
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-11-06T18:00:00.000Z',
    ]);
  });
});

describe('pickQueueSlots', () => {
  const a = new Date('2026-11-05T04:00:00Z');
  const b = new Date('2026-11-05T13:00:00Z');
  const c = new Date('2026-11-06T04:00:00Z');

  it('next free is the first slot no post holds; top is the first slot when free', () => {
    expect(pickQueueSlots([a, b, c], new Set())).toEqual({
      nextFree: a,
      top: a,
    });
  });

  it('with the first slot taken, next free moves on and top is withheld', () => {
    expect(pickQueueSlots([a, b, c], new Set([minuteKey(a)]))).toEqual({
      nextFree: b,
      top: null,
    });
  });

  it('a post anywhere inside the slot minute holds it', () => {
    const inside = new Date(a.getTime() + 30_000);
    expect(
      pickQueueSlots([a, b], new Set([minuteKey(inside)])).nextFree,
    ).toEqual(b);
  });

  it('nothing free means null for both', () => {
    expect(
      pickQueueSlots([a, b], new Set([minuteKey(a), minuteKey(b)])),
    ).toEqual({ nextFree: null, top: null });
    expect(pickQueueSlots([], new Set())).toEqual({
      nextFree: null,
      top: null,
    });
  });
});
