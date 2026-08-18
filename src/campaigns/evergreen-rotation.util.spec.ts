import { computeNextCategoryFire, isPostEligible, pickNextPost, selectVariation } from './evergreen-rotation.util';

const NOW = new Date('2026-08-17T12:00:00Z'); // Monday

function post(overrides: any = {}): any {
  return {
    id: 'p1', status: 'active', recyclePolicy: { mode: 'forever' }, minGapHours: 0,
    recycledCount: 0, lastPublishedAt: null, performanceScore: null, variations: [], ...overrides,
  };
}
const liveCat = { isActive: true, seasonal: null };

describe('computeNextCategoryFire', () => {
  it('returns the next matching weekday+time after `after`', () => {
    // Wednesday(3) 09:00 UTC, from Monday noon → 2026-08-19T09:00Z
    const next = computeNextCategoryFire({ weekdays: [3], times: ['09:00'] }, 'UTC', [], NOW);
    expect(next?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });
  it('skips blackout dates', () => {
    const next = computeNextCategoryFire({ weekdays: [1,2,3], times: ['09:00'] }, 'UTC', ['2026-08-18'], NOW);
    // Mon noon → Tue 18th is blackout → Wed 19th 09:00
    expect(next?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });
  it('returns null when no weekday configured', () => {
    expect(computeNextCategoryFire({ weekdays: [], times: ['09:00'] }, 'UTC', [], NOW)).toBeNull();
  });
});

describe('isPostEligible', () => {
  it('true for an active post in an active category', () => {
    expect(isPostEligible(post(), liveCat, NOW)).toBe(true);
  });
  it('false for a paused/retired post', () => {
    expect(isPostEligible(post({ status: 'paused' }), liveCat, NOW)).toBe(false);
    expect(isPostEligible(post({ status: 'retired' }), liveCat, NOW)).toBe(false);
  });
  it('false when category is inactive', () => {
    expect(isPostEligible(post(), { isActive: false, seasonal: null }, NOW)).toBe(false);
  });
  it('false outside a seasonal window', () => {
    expect(isPostEligible(post(), { isActive: true, seasonal: { startDate: '2026-12-01', endDate: '2026-12-31' } }, NOW)).toBe(false);
  });
  it('false when maxCount reached', () => {
    expect(isPostEligible(post({ recyclePolicy: { mode: 'maxCount', maxCount: 3 }, recycledCount: 3 }), liveCat, NOW)).toBe(false);
  });
  it('false when past expiry', () => {
    expect(isPostEligible(post({ recyclePolicy: { mode: 'expiry', expiryDate: '2026-08-01' } }), liveCat, NOW)).toBe(false);
  });
  it('false when min-gap not satisfied', () => {
    expect(isPostEligible(post({ minGapHours: 48, lastPublishedAt: new Date('2026-08-17T00:00:00Z') }), liveCat, NOW)).toBe(false);
  });
});

describe('pickNextPost', () => {
  it('returns null when nothing eligible', () => {
    expect(pickNextPost([post({ status: 'retired' })], liveCat, NOW)).toBeNull();
  });
  it('prefers the least-recently-published post', () => {
    const a = post({ id: 'a', lastPublishedAt: new Date('2026-08-16T00:00:00Z') });
    const b = post({ id: 'b', lastPublishedAt: new Date('2026-08-10T00:00:00Z') }); // older
    expect(pickNextPost([a, b], liveCat, NOW)?.id).toBe('b');
  });
  it('weights a strong performer ahead of a slightly-older weak one', () => {
    const weakOld = post({ id: 'weakOld', lastPublishedAt: new Date('2026-08-10T00:00:00Z'), performanceScore: 0.0 });
    const strongNewer = post({ id: 'strongNewer', lastPublishedAt: new Date('2026-08-11T00:00:00Z'), performanceScore: 1.0 });
    expect(pickNextPost([weakOld, strongNewer], liveCat, NOW)?.id).toBe('strongNewer');
  });
  it('treats null performanceScore as neutral (never excludes on score)', () => {
    const only = post({ id: 'only', performanceScore: null });
    expect(pickNextPost([only], liveCat, NOW)?.id).toBe('only');
  });
});

describe('selectVariation', () => {
  it('uses base caption on the first fire', () => {
    const p = post({ content: { caption: 'BASE' } as any, variations: [{ id: 'v1', caption: 'V1', source: 'ai' }], recycledCount: 0 });
    expect(selectVariation({ ...p, content: { caption: 'BASE' } } as any)).toEqual({ variationId: null, caption: 'BASE' });
  });
  it('cycles to variation 1 on the second fire', () => {
    const p = { content: { caption: 'BASE' }, variations: [{ id: 'v1', caption: 'V1', source: 'ai' }], recycledCount: 1 } as any;
    expect(selectVariation(p)).toEqual({ variationId: 'v1', caption: 'V1' });
  });
});
