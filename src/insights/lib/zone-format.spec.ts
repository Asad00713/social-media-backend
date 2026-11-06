import { slotOf } from './best-time';
import { clearZoneFormatters, zoneFormatter } from './zone-format';

/** The pre-cache implementation: a new formatter every call. */
function slotOfUncached(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekday = names.indexOf(parts.find((x) => x.type === 'weekday')!.value);
  const hour = Number(parts.find((x) => x.type === 'hour')!.value) % 24;
  return { weekday, slot: Math.floor(hour / 3) };
}

describe('zoneFormatter', () => {
  beforeEach(() => clearZoneFormatters());

  it('builds one formatter per (zone, options) and reuses it', () => {
    const Real = Intl.DateTimeFormat;
    const ctor = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      const a = zoneFormatter('Asia/Karachi', { hour: 'numeric' });
      const b = zoneFormatter('Asia/Karachi', { hour: 'numeric' });
      expect(b).toBe(a);
      expect(ctor).toHaveBeenCalledTimes(1);
      // A different zone or different options is a different formatter.
      expect(zoneFormatter('UTC', { hour: 'numeric' })).not.toBe(a);
      expect(zoneFormatter('Asia/Karachi', { weekday: 'short' })).not.toBe(a);
      expect(ctor).toHaveBeenCalledTimes(3);
    } finally {
      ctor.mockRestore();
    }
    expect(Intl.DateTimeFormat).toBe(Real);
  });

  it('slotOf constructs one formatter however many posts it reads', () => {
    const ctor = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      for (let i = 0; i < 500; i += 1) {
        slotOf(new Date(Date.UTC(2026, 9, 1, i % 24)), 'Europe/Paris');
      }
      expect(ctor).toHaveBeenCalledTimes(1);
    } finally {
      ctor.mockRestore();
    }
  });

  it('gives the same slot as a fresh formatter in every zone, across DST', () => {
    const zones = [
      'UTC',
      'Asia/Karachi',
      'Asia/Kolkata',
      'America/New_York',
      'Europe/London',
      'Australia/Lord_Howe',
      'Pacific/Auckland',
    ];
    // Spring and autumn clock changes in both hemispheres, hour by hour.
    const starts = [
      Date.UTC(2026, 2, 7), // US spring forward 8 Mar
      Date.UTC(2026, 2, 28), // EU spring forward 29 Mar
      Date.UTC(2026, 3, 4), // AU autumn back 5 Apr
      Date.UTC(2026, 9, 24), // EU autumn back 25 Oct
      Date.UTC(2026, 10, 1), // US autumn back 1 Nov
    ];
    let checked = 0;
    for (const tz of zones) {
      for (const start of starts) {
        for (let h = 0; h < 72; h += 1) {
          const at = new Date(start + h * 3_600_000);
          expect(slotOf(at, tz)).toEqual(slotOfUncached(at, tz));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(zones.length * starts.length * 72);
  });

  it('keeps no more than 64 formatters, dropping the least recently used', () => {
    const warm = zoneFormatter('Etc/GMT+1', { hour: 'numeric' });
    const cold = zoneFormatter('Etc/GMT+2', { hour: 'numeric' });
    // 70 more distinct keys: 14 zones x 5 option sets.
    const optionSets: Intl.DateTimeFormatOptions[] = [
      { hour: 'numeric' },
      { minute: 'numeric' },
      { weekday: 'short' },
      { year: 'numeric' },
      { month: 'short' },
    ];
    for (let z = 3; z <= 16; z += 1) {
      for (const o of optionSets) {
        // Touch the warm one every round so it never becomes the oldest.
        zoneFormatter('Etc/GMT+1', { hour: 'numeric' });
        zoneFormatter(`Etc/GMT-${z - 2}`, o);
      }
    }
    expect(zoneFormatter('Etc/GMT+1', { hour: 'numeric' })).toBe(warm);
    expect(zoneFormatter('Etc/GMT+2', { hour: 'numeric' })).not.toBe(cold);
  });
});
