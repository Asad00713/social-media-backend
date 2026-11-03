import { isMeasured, median } from '../../post-performance/engagement-stats';
import type { InsightPost } from './insight-post';

/** Hours in one heatmap column: 8 columns from midnight. */
export const SLOT_HOURS = 3;
export const SLOTS = 24 / SLOT_HOURS;
/** Columns before 06:00. The page shows them only when a post falls there. */
export const NIGHT_SLOTS = 2;
/** A cell needs this many posts for a value; one post is just that post. */
export const MIN_CELL_POSTS = 2;
/** Best time, What works and Next steps need this many measured posts. */
export const MIN_SIGNAL_POSTS = 10;

export type BestMetric = 'engagements' | 'reach';

export interface BestSlot {
  /** 0 = Monday. */
  weekday: number;
  /** 0–7: 3-hour blocks from midnight. */
  slot: number;
}

export interface BestCell extends BestSlot {
  posts: number;
  /** Median of the metric per post; null under MIN_CELL_POSTS. */
  value: number | null;
}

export interface BestTimeGrid {
  /** All 56 cells, Monday first, slot order within a day. */
  cells: BestCell[];
  best: BestSlot | null;
}

const WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** The weekday and 3-hour block an instant falls in, on the wall clock of `tz`. */
export function slotOf(at: Date, tz: string): BestSlot {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const weekday = WEEKDAY[parts.find((x) => x.type === 'weekday')!.value];
  const hour = Number(parts.find((x) => x.type === 'hour')!.value) % 24;
  return { weekday, slot: Math.floor(hour / SLOT_HOURS) };
}

/** The metric a grid is built on, or null when the post doesn't count there. */
function valueOf(p: InsightPost, metric: BestMetric): number | null {
  if (metric === 'reach') return p.reach;
  return isMeasured(p) ? p.engagements : null;
}

/**
 * When the workspace's own posts did best, by weekday × 3-hour block on the
 * workspace's wall clock: each cell's median `metric` per post. Engagements
 * count measured posts; reach counts posts that report reach.
 *
 * The best cell has the highest value, a tie going to the cell with more
 * posts. There is none below MIN_SIGNAL_POSTS posts in the grid, or when no
 * cell is above 0: "Best" on nothing would be noise.
 */
export function bestTimeGrid(
  posts: InsightPost[],
  tz: string,
  metric: BestMetric,
): BestTimeGrid {
  const values: number[][] = Array.from({ length: 7 * SLOTS }, () => []);
  let counted = 0;
  for (const p of posts) {
    const v = valueOf(p, metric);
    if (v === null) continue;
    const { weekday, slot } = slotOf(new Date(p.publishedAt), tz);
    values[weekday * SLOTS + slot].push(v);
    counted += 1;
  }

  const cells = values.map(
    (vs, i): BestCell => ({
      weekday: Math.floor(i / SLOTS),
      slot: i % SLOTS,
      posts: vs.length,
      value: vs.length >= MIN_CELL_POSTS ? median(vs) : null,
    }),
  );

  let best: BestCell | null = null;
  if (counted >= MIN_SIGNAL_POSTS) {
    for (const c of cells) {
      if (c.value === null || c.value <= 0) continue;
      if (
        !best ||
        c.value > best.value! ||
        (c.value === best.value && c.posts > best.posts)
      ) {
        best = c;
      }
    }
  }

  return {
    cells,
    best: best ? { weekday: best.weekday, slot: best.slot } : null,
  };
}

/** Whether any grid holds a post before 06:00, so the night columns show. */
export function usedNightSlots(...grids: BestTimeGrid[]): boolean {
  return grids.some((g) =>
    g.cells.some((c) => c.slot < NIGHT_SLOTS && c.posts > 0),
  );
}
