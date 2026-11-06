import {
  matchesRule,
  nextDateAfter,
  nextPost,
  parseRule,
  parseStored,
  seriesPostId,
  startSeries,
  withinEnd,
  type RecurrenceRule,
  type StoredRecurrence,
} from './recurrence';

const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  freq: 'weekly',
  interval: 1,
  ends: { type: 'never' },
  ...over,
});

/*
 * The same vectors are in the frontend's
 * `src/features/composer-v2/lib/recurrence.test.ts`: the composer's "Next 3"
 * and the post this server creates must agree.
 */
describe('nextDateAfter (shared vectors)', () => {
  it.each([
    [rule({ freq: 'daily' }), '2026-10-15', '2026-10-15', '2026-10-16'],
    [
      rule({ freq: 'daily', interval: 3 }),
      '2026-10-15',
      '2026-10-15',
      '2026-10-18',
    ],
    [rule(), '2026-10-15', '2026-10-15', '2026-10-22'],
    [rule({ byWeekday: [1, 4] }), '2026-10-15', '2026-10-15', '2026-10-19'],
    [
      rule({ interval: 2, byWeekday: [1, 4] }),
      '2026-10-15',
      '2026-10-15',
      '2026-10-26',
    ],
    [rule({ freq: 'monthly' }), '2026-10-15', '2026-10-15', '2026-11-15'],
    [rule({ freq: 'monthly' }), '2026-01-31', '2026-01-31', '2026-02-28'],
    [rule({ freq: 'monthly' }), '2026-01-31', '2026-02-28', '2026-03-31'],
    [
      rule({ freq: 'monthly', interval: 12 }),
      '2026-02-28',
      '2026-02-28',
      '2027-02-28',
    ],
    [rule({ freq: 'monthly' }), '2028-01-29', '2028-01-29', '2028-02-29'],
  ])('%j from %s after %s is %s', (r, anchor, after, expected) => {
    expect(nextDateAfter(r, anchor, after)).toBe(expected);
  });
});

describe('matchesRule / withinEnd', () => {
  it('never before the anchor; always the anchor', () => {
    expect(
      matchesRule(rule({ freq: 'daily' }), '2026-10-15', '2026-10-14'),
    ).toBe(false);
    expect(
      matchesRule(rule({ byWeekday: [1] }), '2026-10-15', '2026-10-15'),
    ).toBe(true);
  });

  it('after N counts posts with the first included; on a date includes it', () => {
    const after = rule({ ends: { type: 'after', count: 4 } });
    expect(withinEnd(after, 4, '2099-01-01')).toBe(true);
    expect(withinEnd(after, 5, '2000-01-01')).toBe(false);
    const on = rule({ ends: { type: 'on', date: '2026-11-05' } });
    expect(withinEnd(on, 99, '2026-11-05')).toBe(true);
    expect(withinEnd(on, 1, '2026-11-06')).toBe(false);
  });
});

describe('parseRule', () => {
  it('accepts a valid rule and drops anything else on it', () => {
    expect(
      parseRule({
        freq: 'weekly',
        interval: 1,
        byWeekday: [4, 1, 4],
        ends: { type: 'after', count: 4, extra: 1 },
        seriesId: 'forged',
        occurrence: 99,
      }),
    ).toEqual({
      freq: 'weekly',
      interval: 1,
      byWeekday: [1, 4],
      ends: { type: 'after', count: 4 },
    });
  });

  it('drops byWeekday on a non-weekly rule', () => {
    expect(
      parseRule({
        freq: 'daily',
        interval: 2,
        byWeekday: [1],
        ends: { type: 'never' },
      }),
    ).toEqual({ freq: 'daily', interval: 2, ends: { type: 'never' } });
  });

  it.each([
    [null],
    ['weekly'],
    [{ freq: 'yearly', interval: 1, ends: { type: 'never' } }],
    [{ freq: 'weekly', interval: 0, ends: { type: 'never' } }],
    [{ freq: 'weekly', interval: 13, ends: { type: 'never' } }],
    [{ freq: 'weekly', interval: 1.5, ends: { type: 'never' } }],
    [{ freq: 'weekly', interval: 1, byWeekday: [7], ends: { type: 'never' } }],
    [
      {
        freq: 'weekly',
        interval: 1,
        byWeekday: 'mon',
        ends: { type: 'never' },
      },
    ],
    [{ freq: 'weekly', interval: 1 }],
    [{ freq: 'weekly', interval: 1, ends: { type: 'after', count: 1 } }],
    [{ freq: 'weekly', interval: 1, ends: { type: 'after', count: 101 } }],
    [{ freq: 'weekly', interval: 1, ends: { type: 'on', date: 'Nov 5' } }],
    [{ freq: 'weekly', interval: 1, ends: { type: 'forever' } }],
  ])('refuses %j', (v) => {
    expect(parseRule(v)).toBeNull();
  });
});

const stored = (over: Partial<StoredRecurrence> = {}): StoredRecurrence => ({
  ...rule(),
  seriesId: 's1',
  occurrence: 1,
  anchorDate: '2026-10-15',
  time: '09:30',
  ...over,
});

describe('parseStored', () => {
  it('needs the series state too', () => {
    expect(parseStored(stored())).toEqual(stored());
    expect(parseStored(rule())).toBeNull();
    expect(parseStored({ ...stored(), occurrence: 0 })).toBeNull();
    expect(parseStored({ ...stored(), time: '9:30' })).toBeNull();
    expect(parseStored({ ...stored(), anchorDate: 'x' })).toBeNull();
    expect(parseStored({ ...stored(), seriesId: '' })).toBeNull();
  });
});

describe('startSeries', () => {
  // Thu 2026-10-15 9:30 AM Karachi.
  const AT = new Date('2026-10-15T04:30:00Z');

  it('a new series: this post is the first, anchored on its own day and time', () => {
    expect(startSeries(rule(), 'd1', AT, 'Asia/Karachi', undefined)).toEqual(
      stored({ seriesId: 'd1' }),
    );
  });

  it('a post already in a series keeps its series and place, re-anchored', () => {
    const moved = new Date('2026-10-23T13:00:00Z'); // Fri 6 PM
    expect(
      startSeries(
        rule(),
        'd3',
        moved,
        'Asia/Karachi',
        stored({ seriesId: 's1', occurrence: 3 }),
      ),
    ).toEqual(
      stored({
        seriesId: 's1',
        occurrence: 3,
        anchorDate: '2026-10-23',
        time: '18:00',
      }),
    );
  });
});

describe('nextPost', () => {
  const AT = new Date('2026-10-15T04:30:00Z'); // Thu 9:30 AM Karachi
  const NOW = new Date('2026-10-15T04:30:05Z');

  it('the next post is the next matching day at the series time, one place on', () => {
    expect(nextPost(stored(), AT, 'Asia/Karachi', NOW)).toEqual({
      at: new Date('2026-10-22T04:30:00Z'),
      recurrence: stored({ occurrence: 2 }),
    });
  });

  it('ends after N posts', () => {
    const r = stored({ ends: { type: 'after', count: 2 } });
    expect(nextPost(r, AT, 'Asia/Karachi', NOW)?.recurrence.occurrence).toBe(2);
    expect(
      nextPost({ ...r, occurrence: 2 }, AT, 'Asia/Karachi', NOW),
    ).toBeNull();
  });

  it('ends on a date, inclusive', () => {
    expect(
      nextPost(
        stored({ ends: { type: 'on', date: '2026-10-22' } }),
        AT,
        'Asia/Karachi',
        NOW,
      ),
    ).not.toBeNull();
    expect(
      nextPost(
        stored({ ends: { type: 'on', date: '2026-10-21' } }),
        AT,
        'Asia/Karachi',
        NOW,
      ),
    ).toBeNull();
  });

  it('skips days whose time has gone by, without counting them', () => {
    const late = new Date('2026-10-25T00:00:00Z'); // a job that ran 10 days late
    expect(nextPost(stored(), AT, 'Asia/Karachi', late)).toEqual({
      at: new Date('2026-10-29T04:30:00Z'),
      recurrence: stored({ occurrence: 2 }),
    });
  });

  it('keeps the wall-clock time across a DST change', () => {
    const ny = stored({ anchorDate: '2026-10-29', time: '09:30' });
    expect(
      nextPost(
        ny,
        new Date('2026-10-29T13:30:00Z'),
        'America/New_York',
        new Date('2026-10-29T13:30:01Z'),
      )?.at.toISOString(),
    ).toBe('2026-11-05T14:30:00.000Z');
  });

  it('reads the next day from where this post actually went, after a move', () => {
    // Series on Thursdays, this one moved to Saturday the 17th.
    const moved = new Date('2026-10-17T04:30:00Z');
    expect(
      nextPost(stored(), moved, 'Asia/Karachi', moved)?.at.toISOString(),
    ).toBe('2026-10-22T04:30:00.000Z');
  });
});

describe('seriesPostId', () => {
  it('is a stable v5-shaped uuid per series and place', () => {
    const a = seriesPostId('s1', 2);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seriesPostId('s1', 2)).toBe(a);
    expect(seriesPostId('s1', 3)).not.toBe(a);
    expect(seriesPostId('s2', 2)).not.toBe(a);
  });
});
