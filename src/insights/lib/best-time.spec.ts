import {
  bestTimeGrid,
  MIN_SIGNAL_POSTS,
  slotOf,
  usedNightSlots,
  type BestCell,
} from './best-time';
import type { InsightPost } from './insight-post';

const post = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-10-15T14:00:00.000Z',
  title: '',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: 0,
  comments: 0,
  shares: 0,
  impressions: null,
  reach: null,
  engagements: 0,
  engagementRate: null,
  imported: false,
  usualMultiplier: null,
  isSettling: false,
  ...over,
});

/** A measured post at `at` with `engagements` likes. */
const at = (iso: string, engagements: number, reach: number | null = null) =>
  post({ publishedAt: iso, likes: engagements, engagements, reach });

const cell = (cells: BestCell[], weekday: number, slot: number) =>
  cells.find((c) => c.weekday === weekday && c.slot === slot)!;

/** `n` filler posts on Monday 09:00–12:00 UTC with `engagements` each. */
const filler = (n: number, engagements = 1) =>
  Array.from({ length: n }, (_, i) =>
    at(
      `2026-09-${String(7 + 7 * (i % 3)).padStart(2, '0')}T09:30:00.000Z`,
      engagements,
    ),
  );

describe('bestTimeGrid', () => {
  it('has 7 × 8 cells, Monday first', () => {
    const { cells } = bestTimeGrid([], 'UTC', 'engagements');
    expect(cells).toHaveLength(56);
    expect(cells[0]).toEqual({ weekday: 0, slot: 0, posts: 0, value: null });
    expect(cells[55]).toMatchObject({ weekday: 6, slot: 7 });
  });

  it('a 19:00 Asia/Karachi post lands in Thu slot 6 on the right weekday across UTC midnight', () => {
    // Thu 15 Oct 19:00 PKT = 14:00 UTC.
    expect(slotOf(new Date('2026-10-15T14:00:00Z'), 'Asia/Karachi')).toEqual({
      weekday: 3,
      slot: 6,
    });
    // Thu 22:00 UTC is already Fri 03:00 in Karachi: Friday, slot 1.
    expect(slotOf(new Date('2026-10-15T22:00:00Z'), 'Asia/Karachi')).toEqual({
      weekday: 4,
      slot: 1,
    });
    const { cells } = bestTimeGrid(
      [at('2026-10-15T14:00:00Z', 5), at('2026-10-08T14:30:00Z', 7)],
      'Asia/Karachi',
      'engagements',
    );
    expect(cell(cells, 3, 6)).toEqual({
      weekday: 3,
      slot: 6,
      posts: 2,
      value: 6,
    });
  });

  it('workspace timezone is used, not UTC', () => {
    const posts = [
      at('2026-10-15T14:00:00Z', 5),
      at('2026-10-08T14:30:00Z', 7),
    ];
    const karachi = bestTimeGrid(posts, 'Asia/Karachi', 'engagements');
    const utc = bestTimeGrid(posts, 'UTC', 'engagements');
    expect(cell(karachi.cells, 3, 6).posts).toBe(2);
    expect(cell(karachi.cells, 3, 4).posts).toBe(0);
    expect(cell(utc.cells, 3, 4).posts).toBe(2);
    expect(cell(utc.cells, 3, 6).posts).toBe(0);
  });

  it('values are the median per post', () => {
    const { cells } = bestTimeGrid(
      [
        at('2026-10-15T14:00:00Z', 1),
        at('2026-10-08T14:00:00Z', 3),
        at('2026-10-01T14:00:00Z', 1000),
      ],
      'Asia/Karachi',
      'engagements',
    );
    expect(cell(cells, 3, 6).value).toBe(3);
  });

  it('a cell with one post has null value, best ignores it', () => {
    const lone = at('2026-10-17T10:00:00Z', 10_000); // Sat 15:00 PKT, slot 5
    const { cells, best } = bestTimeGrid(
      [
        ...filler(MIN_SIGNAL_POSTS - 2, 2),
        at('2026-10-15T14:00:00Z', 50),
        at('2026-10-08T14:00:00Z', 70),
        lone,
      ],
      'Asia/Karachi',
      'engagements',
    );
    expect(cell(cells, 5, 5)).toEqual({
      weekday: 5,
      slot: 5,
      posts: 1,
      value: null,
    });
    expect(best).toEqual({ weekday: 3, slot: 6 });
  });

  it('a tie goes to the cell with more posts', () => {
    const { best } = bestTimeGrid(
      [
        ...filler(MIN_SIGNAL_POSTS - 5, 1),
        // Tue slot 6, scanned first: 2 posts, median 10.
        at('2026-10-13T14:00:00Z', 10),
        at('2026-10-06T14:00:00Z', 10),
        // Thu slot 6: 3 posts, median 10.
        at('2026-10-15T14:00:00Z', 10),
        at('2026-10-08T14:00:00Z', 10),
        at('2026-10-01T14:00:00Z', 10),
      ],
      'Asia/Karachi',
      'engagements',
    );
    expect(best).toEqual({ weekday: 3, slot: 6 });
  });

  it('no best under MIN_SIGNAL_POSTS posts, or when every value is 0', () => {
    const few = [
      ...filler(MIN_SIGNAL_POSTS - 3, 1),
      at('2026-10-15T14:00:00Z', 10),
      at('2026-10-08T14:00:00Z', 10),
    ];
    expect(bestTimeGrid(few, 'Asia/Karachi', 'engagements').best).toBeNull();
    expect(
      bestTimeGrid(
        [...few, at('2026-10-01T14:00:00Z', 10)],
        'Asia/Karachi',
        'engagements',
      ).best,
    ).toEqual({ weekday: 3, slot: 6 });
    expect(bestTimeGrid(filler(12, 0), 'UTC', 'engagements').best).toBeNull();
  });

  it('an unmeasured post counts in no engagement cell', () => {
    const unmeasured = post({
      publishedAt: '2026-10-15T14:00:00Z',
      likes: null,
      comments: null,
      shares: null,
    });
    const { cells } = bestTimeGrid([unmeasured], 'Asia/Karachi', 'engagements');
    expect(cell(cells, 3, 6).posts).toBe(0);
  });

  it('reach grid: available false when nothing reports reach', () => {
    // The grid itself: posts without reach count nowhere.
    const posts = filler(12, 5);
    const reach = bestTimeGrid(posts, 'UTC', 'reach');
    expect(reach.cells.every((c) => c.posts === 0)).toBe(true);
    expect(reach.best).toBeNull();

    const withReach = bestTimeGrid(
      [
        ...Array.from({ length: 10 }, (_, i) =>
          at(`2026-10-15T14:0${i}:00Z`, 1, 100 + i),
        ),
        at('2026-10-14T14:00:00Z', 1000, null),
      ],
      'Asia/Karachi',
      'reach',
    );
    expect(cell(withReach.cells, 3, 6)).toMatchObject({
      posts: 10,
      value: 104.5,
    });
    expect(cell(withReach.cells, 2, 6).posts).toBe(0);
    expect(withReach.best).toEqual({ weekday: 3, slot: 6 });
  });

  it('usedNightSlots true only with a post before 06:00', () => {
    const day = bestTimeGrid([at('2026-10-15T06:00:00Z', 1)], 'UTC', 'reach');
    const dayEng = bestTimeGrid(
      [at('2026-10-15T06:00:00Z', 1)],
      'UTC',
      'engagements',
    );
    expect(usedNightSlots(dayEng, day)).toBe(false);
    const night = bestTimeGrid(
      [at('2026-10-15T05:59:00Z', 1)],
      'UTC',
      'engagements',
    );
    expect(usedNightSlots(night)).toBe(true);
    // 23:00 UTC is 04:00 next day in Karachi: a night post there.
    expect(
      usedNightSlots(
        bestTimeGrid(
          [at('2026-10-15T23:00:00Z', 1)],
          'Asia/Karachi',
          'engagements',
        ),
      ),
    ).toBe(true);
  });
});
