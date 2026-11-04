import type { Ratio } from '../dto/contract';

/** Runtime list of `Ratio` values, for validation. */
export const RATIOS = [
  '1:1',
  '4:5',
  '9:16',
  '16:9',
] as const satisfies readonly Ratio[];

/**
 * How far width/height may stray from a ratio and still match it. Real
 * exports are off by a pixel or two (1080×1349 is a 4:5 post).
 */
export const RATIO_TOLERANCE = 0.03;

const TARGET: Record<Ratio, number> = {
  '1:1': 1,
  '4:5': 0.8,
  '9:16': 0.5625,
  '16:9': 16 / 9,
};

/** The width/height band a ratio filter matches: target × (1 ∓ 3%). */
export function ratioBounds(r: Ratio): { min: number; max: number } {
  const target = TARGET[r];
  return {
    min: target * (1 - RATIO_TOLERANCE),
    max: target * (1 + RATIO_TOLERANCE),
  };
}
