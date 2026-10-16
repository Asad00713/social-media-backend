import {
  addDays,
  computeSlots,
  describeSlot,
  localDateOf,
  resolveWeekStart,
  safeTimeZone,
  wallClockToUtc,
} from './first-week-slots';

describe('first-week slots', () => {
  describe('localDateOf', () => {
    it('reads the calendar date in the workspace zone, not UTC', () => {
      // 20:30Z on the 14th is already 01:30 on the 15th in Karachi (UTC+5)
      expect(
        localDateOf(new Date('2026-10-14T20:30:00Z'), 'Asia/Karachi'),
      ).toBe('2026-10-15');
      expect(localDateOf(new Date('2026-10-14T20:30:00Z'), 'UTC')).toBe(
        '2026-10-14',
      );
    });
  });

  describe('addDays', () => {
    it('rolls over month and year ends', () => {
      expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
      expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    });
  });

  describe('resolveWeekStart', () => {
    it('starts tomorrow in the workspace zone', () => {
      expect(
        resolveWeekStart(
          new Date('2026-10-14T20:30:00Z'),
          'Asia/Karachi',
          null,
        ),
      ).toBe('2026-10-16');
    });

    it('keeps an existing start that is still tomorrow or later', () => {
      expect(
        resolveWeekStart(new Date('2026-10-14T10:00:00Z'), 'UTC', '2026-10-16'),
      ).toBe('2026-10-16');
    });

    it('replaces a start that has already passed', () => {
      expect(
        resolveWeekStart(new Date('2026-10-14T10:00:00Z'), 'UTC', '2026-10-10'),
      ).toBe('2026-10-15');
    });

    it('ignores a malformed stored start', () => {
      expect(
        resolveWeekStart(new Date('2026-10-14T10:00:00Z'), 'UTC', 'oops'),
      ).toBe('2026-10-15');
    });
  });

  describe('wallClockToUtc', () => {
    it('converts a fixed-offset zone', () => {
      expect(
        wallClockToUtc('2026-10-16', '09:00', 'Asia/Karachi').toISOString(),
      ).toBe('2026-10-16T04:00:00.000Z');
    });

    it('is DST-correct on both sides of the autumn change (New York, 2026-11-01)', () => {
      expect(
        wallClockToUtc('2026-10-30', '09:00', 'America/New_York').toISOString(),
      ).toBe('2026-10-30T13:00:00.000Z'); // EDT, UTC-4
      expect(
        wallClockToUtc('2026-11-01', '09:00', 'America/New_York').toISOString(),
      ).toBe('2026-11-01T14:00:00.000Z'); // EST, UTC-5
    });
  });

  describe('computeSlots', () => {
    it('returns 5 slots, one a day, alternating 9:00 / 18:00 / 9:00 / 18:00 / 9:00', () => {
      const slots = computeSlots('2026-10-16', 'Asia/Karachi');
      expect(slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4]);
      expect(slots.map((s) => s.localTime)).toEqual([
        '09:00',
        '18:00',
        '09:00',
        '18:00',
        '09:00',
      ]);
      expect(slots.map((s) => s.localDate)).toEqual([
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
        '2026-10-19',
        '2026-10-20',
      ]);
      expect(slots.map((s) => s.at.toISOString())).toEqual([
        '2026-10-16T04:00:00.000Z',
        '2026-10-17T13:00:00.000Z',
        '2026-10-18T04:00:00.000Z',
        '2026-10-19T13:00:00.000Z',
        '2026-10-20T04:00:00.000Z',
      ]);
    });

    it('keeps local wall-clock times across a DST change', () => {
      const slots = computeSlots('2026-10-30', 'America/New_York');
      expect(slots.map((s) => s.at.toISOString())).toEqual([
        '2026-10-30T13:00:00.000Z', // 9:00 EDT
        '2026-10-31T22:00:00.000Z', // 18:00 EDT
        '2026-11-01T14:00:00.000Z', // 9:00 EST
        '2026-11-02T23:00:00.000Z', // 18:00 EST
        '2026-11-03T14:00:00.000Z', // 9:00 EST
      ]);
    });

    it('falls back to UTC for an unknown zone instead of throwing', () => {
      const slots = computeSlots('2026-10-15', 'Not/AZone');
      expect(slots[0].at.toISOString()).toBe('2026-10-15T09:00:00.000Z');
      expect(slots[1].at.toISOString()).toBe('2026-10-16T18:00:00.000Z');
    });

    it('falls back to UTC for an empty zone', () => {
      expect(safeTimeZone('')).toBe('UTC');
      expect(safeTimeZone(null)).toBe('UTC');
      expect(computeSlots('2026-10-15', '')[0].at.toISOString()).toBe(
        '2026-10-15T09:00:00.000Z',
      );
    });
  });

  describe('describeSlot', () => {
    it('names the weekday and time in the workspace zone', () => {
      const d = describeSlot(new Date('2026-10-16T04:00:00Z'), 'Asia/Karachi');
      expect(d.weekday).toBe('Friday');
      expect(d.time).toBe('9:00 AM');
    });
  });
});
