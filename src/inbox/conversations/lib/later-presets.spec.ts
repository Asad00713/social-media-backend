import { resolveLaterPreset } from './later-presets';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('resolveLaterPreset', () => {
  it.each([
    [
      'Asia/Karachi',
      '2026-10-26T12:00:00Z',
      'later_today',
      '2026-10-26T13:00:00.000Z',
    ],
    [
      'Asia/Karachi',
      '2026-10-26T12:00:00Z',
      'tomorrow',
      '2026-10-27T04:00:00.000Z',
    ],
    [
      'Asia/Karachi',
      '2026-10-26T12:00:00Z',
      'next_week',
      '2026-11-02T04:00:00.000Z',
    ],
    ['Asia/Karachi', '2026-10-26T13:00:00Z', 'later_today', null],
    [
      'America/New_York',
      '2026-03-07T20:00:00Z',
      'later_today',
      '2026-03-07T23:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-07T20:00:00Z',
      'tomorrow',
      '2026-03-08T13:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-07T20:00:00Z',
      'next_week',
      '2026-03-09T13:00:00.000Z',
    ],
    [
      'Mars/Olympus',
      '2026-10-26T12:00:00Z',
      'later_today',
      '2026-10-26T18:00:00.000Z',
    ],
    [
      'Mars/Olympus',
      '2026-10-26T12:00:00Z',
      'tomorrow',
      '2026-10-27T09:00:00.000Z',
    ],
  ] as const)('%s %s %s', (zone, now, preset, expected) => {
    expect(iso(resolveLaterPreset(preset, new Date(now), zone))).toBe(expected);
  });
});

describe('resolveLaterPreset where the local date differs from the UTC date', () => {
  it.each([
    // Mon 2026-10-26 01:00 PKT while UTC is still Sun 10-25
    [
      'Asia/Karachi',
      '2026-10-25T20:00:00Z',
      'later_today',
      '2026-10-26T13:00:00.000Z',
    ],
    [
      'Asia/Karachi',
      '2026-10-25T20:00:00Z',
      'tomorrow',
      '2026-10-27T04:00:00.000Z',
    ],
    [
      'Asia/Karachi',
      '2026-10-25T20:00:00Z',
      'next_week',
      '2026-11-02T04:00:00.000Z',
    ],
    // Sun 2026-03-08 (DST starts, 02:00 EST -> EDT): 12:00 local is EDT
    [
      'America/New_York',
      '2026-03-08T16:00:00Z',
      'later_today',
      '2026-03-08T22:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-08T16:00:00Z',
      'tomorrow',
      '2026-03-09T13:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-08T16:00:00Z',
      'next_week',
      '2026-03-09T13:00:00.000Z',
    ],
    // Los Angeles Mon 2026-10-26 20:00 PDT = Tue 03:00Z: local date is behind UTC
    ['America/Los_Angeles', '2026-10-27T03:00:00Z', 'later_today', null],
    [
      'America/Los_Angeles',
      '2026-10-27T03:00:00Z',
      'tomorrow',
      '2026-10-27T16:00:00.000Z',
    ],
    [
      'America/Los_Angeles',
      '2026-10-27T03:00:00Z',
      'next_week',
      '2026-11-02T17:00:00.000Z',
    ],
    [
      'America/Los_Angeles',
      '2026-10-27T00:00:00Z',
      'later_today',
      '2026-10-27T01:00:00.000Z',
    ],
  ] as const)('%s %s %s', (zone, now, preset, expected) => {
    expect(iso(resolveLaterPreset(preset, new Date(now), zone))).toBe(expected);
  });
});
