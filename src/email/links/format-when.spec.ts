import {
  formatDay,
  formatMonthDay,
  formatTime,
  formatWhen,
  initials,
} from './format-when';

describe('formatTime', () => {
  it('formats the time of day in the zone, with no zone name', () => {
    expect(formatTime(new Date('2026-11-15T04:12:00Z'), 'Asia/Karachi')).toBe(
      '9:12 AM',
    );
    expect(
      formatTime(new Date('2026-07-01T18:05:00Z'), 'America/New_York'),
    ).toBe('2:05 PM');
  });

  it('falls back to UTC for an invalid zone', () => {
    expect(formatTime(new Date('2026-10-26T05:42:00Z'), 'Not/AZone')).toBe(
      '5:42 AM',
    );
  });
});

describe('formatWhen', () => {
  const at = new Date('2026-10-26T05:42:00Z');

  it('formats in the zone with a short zone name', () => {
    expect(formatWhen(at, 'Asia/Karachi')).toBe(
      'Oct 26, 2026 at 10:42 AM GMT+5',
    );
  });

  it('falls back to UTC for an invalid zone', () => {
    expect(formatWhen(at, 'Not/AZone')).toBe('Oct 26, 2026 at 5:42 AM UTC');
    expect(formatWhen(at, '')).toBe('Oct 26, 2026 at 5:42 AM UTC');
  });

  it('crosses the date line with the zone, not the server', () => {
    expect(formatWhen(new Date('2026-10-26T22:30:00Z'), 'Asia/Karachi')).toBe(
      'Oct 27, 2026 at 3:30 AM GMT+5',
    );
  });

  it('renders PM and a named US zone', () => {
    expect(
      formatWhen(new Date('2026-07-01T18:05:00Z'), 'America/New_York'),
    ).toBe('Jul 1, 2026 at 2:05 PM EDT');
  });
});

describe('formatMonthDay', () => {
  it('drops the year and uses the zone, not the server', () => {
    expect(
      formatMonthDay(new Date('2026-11-01T22:00:00Z'), 'Asia/Karachi'),
    ).toBe('Nov 2');
    expect(formatMonthDay(new Date('2026-11-01T22:00:00Z'), 'nope')).toBe(
      'Nov 1',
    );
  });
});

describe('formatDay', () => {
  it('formats the day in the zone', () => {
    expect(formatDay(new Date('2026-11-01T22:00:00Z'), 'Asia/Karachi')).toBe(
      'Nov 2, 2026',
    );
  });

  it('falls back to UTC for an invalid zone', () => {
    expect(formatDay(new Date('2026-11-01T22:00:00Z'), 'nope')).toBe(
      'Nov 1, 2026',
    );
  });
});

describe('initials', () => {
  it('takes first and last word of a name', () => {
    expect(initials('M Rehman')).toBe('MR');
    expect(initials('Ali Raza Khan')).toBe('AK');
  });

  it('takes two letters of a single word or an email local part', () => {
    expect(initials('sana@x.pk')).toBe('SA');
    expect(initials('Madonna')).toBe('MA');
    expect(initials('x')).toBe('X');
  });

  it('copes with blank input and non-latin letters', () => {
    expect(initials('   ')).toBe('');
    expect(initials('علی رضا')).toBe('عر');
  });
});
