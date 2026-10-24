import {
  mergePrefs,
  PLANNER_PREF_DEFAULTS,
  resolvePrefs,
} from './planner-prefs';

const UUID = '33333333-3333-4333-8333-333333333333';

describe('resolvePrefs', () => {
  it('returns the defaults for undefined, null and non-objects', () => {
    for (const v of [undefined, null, 'x', 7, true, [], [1, 2]]) {
      expect(resolvePrefs(v)).toEqual(PLANNER_PREF_DEFAULTS);
    }
  });

  it('has the spec defaults', () => {
    expect(PLANNER_PREF_DEFAULTS).toEqual({
      postSize: 'comfortable',
      colorBy: 'status',
      show: {
        media: true,
        campaigns: true,
        notes: true,
        events: true,
        weekends: true,
      },
      publishedPosts: 'fade',
      weekStartsOn: 0,
      visibleCalendarIds: null,
      eventDisplay: 'full',
      bestTimesInWeek: false,
      bestTimesSource: 'own',
      suggestBestTime: true,
    });
  });

  it('drops a wrongly typed key and keeps the valid ones', () => {
    const r = resolvePrefs({ postSize: 'huge', colorBy: 'channel' });
    expect(r.postSize).toBe('comfortable');
    expect(r.colorBy).toBe('channel');
  });

  it('drops only the wrongly typed nested show key', () => {
    const r = resolvePrefs({ show: { media: false, notes: 'no', bogus: 1 } });
    expect(r.show).toEqual({ ...PLANNER_PREF_DEFAULTS.show, media: false });
    expect(r.show).not.toHaveProperty('bogus');
  });

  it('treats a non-object show as defaults', () => {
    expect(resolvePrefs({ show: 'x' }).show).toEqual(
      PLANNER_PREF_DEFAULTS.show,
    );
    expect(resolvePrefs({ show: [true] }).show).toEqual(
      PLANNER_PREF_DEFAULTS.show,
    );
  });

  it('rejects weekStartsOn outside 0 and 1', () => {
    expect(resolvePrefs({ weekStartsOn: 2 }).weekStartsOn).toBe(0);
    expect(resolvePrefs({ weekStartsOn: '1' }).weekStartsOn).toBe(0);
    expect(resolvePrefs({ weekStartsOn: 1 }).weekStartsOn).toBe(1);
  });

  it('keeps an array of strings and nulls anything else for visibleCalendarIds', () => {
    expect(
      resolvePrefs({ visibleCalendarIds: [UUID] }).visibleCalendarIds,
    ).toEqual([UUID]);
    expect(resolvePrefs({ visibleCalendarIds: [] }).visibleCalendarIds).toEqual(
      [],
    );
    for (const v of ['x', [1], [UUID, 2], {}, 5, undefined]) {
      expect(
        resolvePrefs({ visibleCalendarIds: v }).visibleCalendarIds,
      ).toBeNull();
    }
  });

  it('never throws on hostile input', () => {
    expect(() =>
      resolvePrefs({ show: null, visibleCalendarIds: null, postSize: {} }),
    ).not.toThrow();
  });

  it('returns a fresh object, so callers cannot corrupt the defaults', () => {
    const r = resolvePrefs(undefined);
    r.show.media = false;
    expect(PLANNER_PREF_DEFAULTS.show.media).toBe(true);
  });
});

describe('mergePrefs', () => {
  it('merges show per key and keeps untouched ones', () => {
    expect(
      mergePrefs({ show: { notes: false } }, { show: { media: false } }),
    ).toEqual({ show: { notes: false, media: false } });
  });

  it('shallow-merges top-level keys and keeps the others', () => {
    expect(mergePrefs({ colorBy: 'channel' }, { postSize: 'compact' })).toEqual(
      { colorBy: 'channel', postSize: 'compact' },
    );
  });

  it('visibleCalendarIds: null removes the key; an array sets it', () => {
    expect(
      mergePrefs(
        { visibleCalendarIds: [UUID], colorBy: 'channel' },
        { visibleCalendarIds: null },
      ),
    ).toEqual({ colorBy: 'channel' });
    expect(mergePrefs({}, { visibleCalendarIds: [UUID] })).toEqual({
      visibleCalendarIds: [UUID],
    });
    expect(mergePrefs({}, { visibleCalendarIds: [] })).toEqual({
      visibleCalendarIds: [],
    });
  });

  it('an empty patch changes nothing', () => {
    expect(mergePrefs({ colorBy: 'campaign' }, {})).toEqual({
      colorBy: 'campaign',
    });
  });

  it('ignores a null show in the patch', () => {
    expect(
      mergePrefs({ show: { notes: false } }, { show: null as never }),
    ).toEqual({ show: { notes: false } });
  });

  it('writes only known, valid keys: stored garbage is not carried forward', () => {
    expect(
      mergePrefs(
        { junk: 1, postSize: 'huge', show: { bogus: true, notes: false } },
        { colorBy: 'channel' },
      ),
    ).toEqual({ colorBy: 'channel', show: { notes: false } });
  });

  it('recovers from a non-object stored value', () => {
    for (const v of [null, undefined, 'x', [], 3]) {
      expect(mergePrefs(v, { weekStartsOn: 1 })).toEqual({ weekStartsOn: 1 });
    }
  });

  it('does not mutate its inputs', () => {
    const stored = { show: { notes: false } };
    mergePrefs(stored, { show: { media: false } });
    expect(stored).toEqual({ show: { notes: false } });
  });
});
