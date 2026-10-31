import {
  StorageFullException,
  storageLevel,
  storagePercent,
  wouldExceed,
} from './storage';

describe('storage helpers', () => {
  it.each([
    [0, 100, 0],
    [45, 100, 45],
    [899, 1000, 89.9],
    [1500, 1000, 100],
    [5, 0, 100],
    [0, 0, 0],
  ])('storagePercent(%d, %d) = %d', (used, limit, expected) => {
    expect(storagePercent(used, limit)).toBe(expected);
  });

  it.each([
    [899, 1000, 'ok'],
    [900, 1000, 'almost_full'],
    [1000, 1000, 'full'],
    [1200, 1000, 'full'],
    [0, 0, 'full'],
  ])('storageLevel(%d, %d) = %s', (used, limit, expected) => {
    expect(storageLevel(used, limit)).toBe(expected);
  });

  it.each([
    [0, 10, 10, false],
    [0, 11, 10, true],
    [10, 0, 10, true],
    [9, 0, 10, false],
  ])('wouldExceed(%d, %d, %d) = %s', (used, incoming, limit, expected) => {
    expect(wouldExceed(used, incoming, limit)).toBe(expected);
  });

  it('StorageFullException is a 413 with the STORAGE_FULL body', () => {
    const e = new StorageFullException({ used: 9, limit: 10 });
    expect(e.getStatus()).toBe(413);
    expect(e.getResponse()).toEqual({
      code: 'STORAGE_FULL',
      message: 'Storage is full. Free up space or upgrade your plan.',
      used: 9,
      limit: 10,
    });
  });
});
