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
