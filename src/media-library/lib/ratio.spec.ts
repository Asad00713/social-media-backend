import { RATIO_TOLERANCE, ratioBounds } from './ratio';

describe('ratioBounds', () => {
  it('uses a 3% tolerance', () => {
    expect(RATIO_TOLERANCE).toBe(0.03);
  });

  it('4:5 spans 0.776 to 0.824', () => {
    const { min, max } = ratioBounds('4:5');
    expect(min).toBeCloseTo(0.776, 4);
    expect(max).toBeCloseTo(0.824, 4);
  });

  it('16:9 spans 1.72444 to 1.83111', () => {
    const { min, max } = ratioBounds('16:9');
    expect(min).toBeCloseTo(1.72444, 4);
    expect(max).toBeCloseTo(1.83111, 4);
  });

  it('1:1 and 9:16 centre on 1 and 0.5625', () => {
    expect(ratioBounds('1:1')).toEqual({ min: 0.97, max: 1.03 });
    const tall = ratioBounds('9:16');
    expect(tall.min).toBeCloseTo(0.5625 * 0.97, 6);
    expect(tall.max).toBeCloseTo(0.5625 * 1.03, 6);
  });
});
