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
});
