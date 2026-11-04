import { nextFreeSlot } from './next-free-slot';

const KHI = 'Asia/Karachi';
const NY = 'America/New_York';
/** Sat 17 Oct 2026, 12:00 UTC (17:00 in Karachi). */
const NOW = new Date('2026-10-17T12:00:00Z');
/** Thursday, 6–9 PM. */
const THU_EVENING = { weekday: 3, slot: 6 };

describe('nextFreeSlot', () => {
  it('finds the next occurrence and suggests one hour into it', () => {
    expect(nextFreeSlot(THU_EVENING, [], KHI, NOW)).toEqual({
      nextFreeDate: '2026-10-22',
      // 19:00 PKT.
      suggestedAt: '2026-10-22T14:00:00.000Z',
    });
  });

  it('a scheduled time inside the slot takes it; one just before or after it does not', () => {
    // Channel filtering is the caller's query (proven in the signals DB spec).
    const inside = new Date('2026-10-22T15:59:00Z'); // 20:59 PKT
    const after = new Date('2026-10-29T16:00:00Z'); // 21:00 PKT, next week
    expect(nextFreeSlot(THU_EVENING, [inside, after], KHI, NOW)).toEqual({
      nextFreeDate: '2026-10-29',
      suggestedAt: '2026-10-29T14:00:00.000Z',
    });
    const before = new Date('2026-10-22T12:59:00Z'); // 17:59 PKT
    expect(nextFreeSlot(THU_EVENING, [before], KHI, NOW)?.nextFreeDate).toBe(
      '2026-10-22',
    );
  });

  it('today counts only when the slot has not started', () => {
    // Saturday 17:00 PKT: Saturday 6–9 PM is still ahead, 3–6 PM is not.
    expect(
      nextFreeSlot({ weekday: 5, slot: 6 }, [], KHI, NOW)?.nextFreeDate,
    ).toBe('2026-10-17');
    expect(
      nextFreeSlot({ weekday: 5, slot: 5 }, [], KHI, NOW)?.nextFreeDate,
    ).toBe('2026-10-24');
  });

  it('next free returns null when all 8 weeks are taken', () => {
    const weekly = Array.from(
      { length: 8 },
      (_, i) =>
        new Date(Date.parse('2026-10-22T14:30:00Z') + i * 7 * 86_400_000),
    );
    expect(nextFreeSlot(THU_EVENING, weekly, KHI, NOW)).toBeNull();
    // Leave the 8th week free and it is found.
    expect(
      nextFreeSlot(THU_EVENING, weekly.slice(0, 7), KHI, NOW)?.nextFreeDate,
    ).toBe('2026-12-10');
    expect(
      nextFreeSlot(THU_EVENING, weekly.slice(0, 7), KHI, NOW, 7),
    ).toBeNull();
  });

  it('the last slot of the day runs to midnight', () => {
    const late = new Date('2026-10-22T18:59:00Z'); // Thu 23:59 PKT
    expect(
      nextFreeSlot({ weekday: 3, slot: 7 }, [late], KHI, NOW)?.nextFreeDate,
    ).toBe('2026-10-29');
  });

  it('suggestedAt survives a DST change in America/New_York', () => {
    // DST ends Sun 1 Nov 2026. Sunday 6–9 PM, from Wed 28 Oct.
    const now = new Date('2026-10-28T12:00:00Z');
    const sunday = { weekday: 6, slot: 6 };
    expect(nextFreeSlot(sunday, [], NY, now)).toEqual({
      nextFreeDate: '2026-11-01',
      suggestedAt: '2026-11-02T00:00:00.000Z', // 19:00 EST
    });
    // From Wed 21 Oct the first Sunday is still on EDT; taking it moves the
    // suggestion across the change, and the wall clock stays 7 PM.
    const before = new Date('2026-10-21T12:00:00Z');
    expect(nextFreeSlot(sunday, [], NY, before)?.suggestedAt).toBe(
      '2026-10-25T23:00:00.000Z', // 19:00 EDT
    );
    expect(
      nextFreeSlot(sunday, [new Date('2026-10-25T23:30:00Z')], NY, before),
    ).toEqual({
      nextFreeDate: '2026-11-01',
      suggestedAt: '2026-11-02T00:00:00.000Z',
    });
  });
});
