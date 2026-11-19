import { utcToWallClock, wallClockToUtc } from './wall-clock';

describe('wall-clock', () => {
  it('reads a UTC instant as London wall-clock on the spring-forward day', () => {
    // 01:30Z on 29 Mar 2026 is the first half hour of BST.
    expect(
      utcToWallClock(new Date('2026-03-29T01:30:00Z'), 'Europe/London'),
    ).toEqual({ date: '2026-03-29', time: '02:30:00' });
  });

  it('round-trips an instant through Asia/Karachi wall-clock', () => {
    const at = new Date('2026-11-17T04:00:45Z');
    const wall = utcToWallClock(at, 'Asia/Karachi');
    expect(wall).toEqual({ date: '2026-11-17', time: '09:00:45' });
    expect(wallClockToUtc(wall.date, wall.time, 'Asia/Karachi')).toEqual(at);
  });

  it('keeps reading HH:mm as the campaign schedule writes it', () => {
    expect(wallClockToUtc('2026-11-17', '09:00', 'Asia/Karachi')).toEqual(
      new Date('2026-11-17T04:00:00Z'),
    );
    expect(wallClockToUtc('2026-07-01', '09:00', 'America/New_York')).toEqual(
      new Date('2026-07-01T13:00:00Z'),
    );
  });

  it('rejects a malformed date or time', () => {
    expect(wallClockToUtc('2026-1-1', '09:00', 'UTC')).toBeNull();
    expect(wallClockToUtc('2026-01-01', '9:00', 'UTC')).toBeNull();
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(wallClockToUtc('2026-01-01', '09:00', 'Mars/Olympus')).toEqual(
      new Date('2026-01-01T09:00:00Z'),
    );
    expect(
      utcToWallClock(new Date('2026-01-01T09:00:00Z'), 'Mars/Olympus'),
    ).toEqual({ date: '2026-01-01', time: '09:00:00' });
  });

  it('writes midnight as 00, never 24', () => {
    expect(
      utcToWallClock(new Date('2026-01-01T19:00:00Z'), 'Asia/Karachi'),
    ).toEqual({ date: '2026-01-02', time: '00:00:00' });
  });

  describe('DST: the same wall-clock reads back on transition days', () => {
    it.each([
      // [zone, date, time, UTC instant]
      ['America/New_York', '2027-03-14', '05:00:00', '2027-03-14T09:00:00Z'],
      ['America/New_York', '2027-11-07', '04:00:00', '2027-11-07T09:00:00Z'],
      ['Europe/Paris', '2027-03-28', '01:30:00', '2027-03-28T00:30:00Z'],
      ['Australia/Sydney', '2027-10-02', '20:00:00', '2027-10-02T10:00:00Z'],
      ['Pacific/Kiritimati', '2027-01-01', '00:30:00', '2026-12-31T10:30:00Z'],
      ['Pacific/Pago_Pago', '2027-01-01', '23:30:00', '2027-01-02T10:30:00Z'],
    ])('%s %s %s', (zone, date, time, utc) => {
      const at = wallClockToUtc(date, time, zone);
      expect(at).toEqual(new Date(utc));
      expect(utcToWallClock(at!, zone)).toEqual({ date, time });
    });

    it('a time that never happens (spring-forward gap) shifts forward by the gap', () => {
      // New York skips 02:00-03:00 on 14 Mar 2027: 02:30 is 03:30 EDT.
      const at = wallClockToUtc('2027-03-14', '02:30', 'America/New_York');
      expect(at).toEqual(new Date('2027-03-14T07:30:00Z'));
      expect(utcToWallClock(at!, 'America/New_York')).toEqual({
        date: '2027-03-14',
        time: '03:30:00',
      });
      // Paris skips 02:00-03:00 on 28 Mar 2027: 02:15 is 03:15 CEST.
      expect(wallClockToUtc('2027-03-28', '02:15', 'Europe/Paris')).toEqual(
        new Date('2027-03-28T01:15:00Z'),
      );
    });

    it('a time that happens twice (fall-back hour) is its first occurrence', () => {
      // New York repeats 01:00-02:00 on 7 Nov 2027: 01:30 EDT comes first.
      expect(wallClockToUtc('2027-11-07', '01:30', 'America/New_York')).toEqual(
        new Date('2027-11-07T05:30:00Z'),
      );
      // Sydney repeats 02:00-03:00 on 4 Apr 2027: 02:30 AEDT comes first.
      expect(wallClockToUtc('2027-04-04', '02:30', 'Australia/Sydney')).toEqual(
        new Date('2027-04-03T15:30:00Z'),
      );
    });
  });
});
