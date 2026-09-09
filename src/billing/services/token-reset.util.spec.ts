import { getNextTokenResetDate } from './token-reset.util';

describe('getNextTokenResetDate', () => {
  it('is the first of next month', () => {
    const d = getNextTokenResetDate(new Date(2026, 0, 15, 13, 45));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(1); // February
    expect(d.getDate()).toBe(1);
  });

  it('rolls the year over from December', () => {
    const d = getNextTokenResetDate(new Date(2026, 11, 20));
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0); // January
    expect(d.getDate()).toBe(1);
  });

  it('starts the day at midnight so the reset fires on the 1st', () => {
    const d = getNextTokenResetDate(new Date(2026, 4, 9, 23, 59, 59));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  // The reset is gated on `new Date() >= resetDate`, so the date must be
  // strictly in the future — a date in the past would reset on every single
  // call, and one equal to now would reset immediately on creation.
  it('is always in the future', () => {
    const now = new Date(2026, 1, 28, 12, 0);
    expect(getNextTokenResetDate(now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('is still in the future on the last instant of a month', () => {
    const now = new Date(2026, 0, 31, 23, 59, 59, 999);
    expect(getNextTokenResetDate(now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('defaults to the current time', () => {
    const d = getNextTokenResetDate();
    expect(d.getTime()).toBeGreaterThan(Date.now());
    expect(d.getDate()).toBe(1);
  });
});
