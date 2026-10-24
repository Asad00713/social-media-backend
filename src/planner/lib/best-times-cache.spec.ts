import { BestTimesCache } from './best-times-cache';

describe('BestTimesCache', () => {
  let t: number;
  const make = (max = 2) => new BestTimesCache<string>(1000, max, () => t);
  beforeEach(() => {
    t = 0;
  });

  it('hits within the TTL', () => {
    const c = make();
    c.set('a', 'v1', 'x');
    t = 999;
    expect(c.get('a', 'v1')).toBe('x');
  });

  it('misses after the TTL', () => {
    const c = make();
    c.set('a', 'v1', 'x');
    t = 1000;
    expect(c.get('a', 'v1')).toBeUndefined();
  });

  it('misses when the version differs', () => {
    const c = make();
    c.set('a', 'v1', 'x');
    expect(c.get('a', 'v2')).toBeUndefined();
  });

  it('evicts the oldest entry at capacity', () => {
    const c = make(2);
    c.set('a', 'v', '1');
    c.set('b', 'v', '2');
    c.set('c', 'v', '3');
    expect(c.get('a', 'v')).toBeUndefined();
    expect(c.get('b', 'v')).toBe('2');
    expect(c.get('c', 'v')).toBe('3');
  });

  it('overwriting a key does not evict another', () => {
    const c = make(2);
    c.set('a', 'v', '1');
    c.set('b', 'v', '2');
    c.set('a', 'v', '9');
    expect(c.get('a', 'v')).toBe('9');
    expect(c.get('b', 'v')).toBe('2');
  });
});
