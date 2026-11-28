import {
  DEFAULT_PREFERENCES,
  explicitKeysOf,
  mergePreferences,
  pickPreferencePatch,
  toPreferencesResponse,
} from './user-preferences';

describe('DEFAULT_PREFERENCES', () => {
  it('is the spec 5.4 default set', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      theme: 'system',
      language: 'en',
      timezone: null,
      timeFormat: '12h',
      weekStart: 'monday',
      dateFormat: 'D_MMM_YYYY',
      startPage: 'home',
      hiddenModules: [],
      composerDefaultWhen: 'draft',
    });
  });
});

describe('mergePreferences', () => {
  it('drops unknown keys and invalid values, keeps valid ones', () => {
    const merged = mergePreferences({
      theme: 'dark',
      bogus: 1,
      weekStart: 'friday',
    });
    expect(merged).toEqual({ ...DEFAULT_PREFERENCES, theme: 'dark' });
    expect(merged).not.toHaveProperty('bogus');
  });

  it.each([null, undefined, 'dark', 5, [], [1]])(
    'turns the non-object %p into the defaults',
    (stored) => {
      expect(mergePreferences(stored)).toEqual(DEFAULT_PREFERENCES);
    },
  );

  it('returns every field for an empty object', () => {
    expect(mergePreferences({})).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps an explicit null time zone and a valid IANA one', () => {
    expect(mergePreferences({ timezone: null }).timezone).toBeNull();
    expect(mergePreferences({ timezone: 'Asia/Karachi' }).timezone).toBe(
      'Asia/Karachi',
    );
  });

  it('falls back to null for a stored zone that is not IANA', () => {
    expect(mergePreferences({ timezone: 'Mars/Olympus' }).timezone).toBeNull();
    expect(mergePreferences({ timezone: 7 }).timezone).toBeNull();
  });

  it('keeps only valid, deduped hidden modules', () => {
    expect(
      mergePreferences({
        hiddenModules: ['inbox', 'home', 'inbox', 'library', 3],
      }).hiddenModules,
    ).toEqual(['inbox', 'library']);
    expect(mergePreferences({ hiddenModules: 'inbox' }).hiddenModules).toEqual(
      [],
    );
  });

  it('never shares the default hiddenModules array', () => {
    const a = mergePreferences({});
    a.hiddenModules.push('inbox');
    expect(mergePreferences({}).hiddenModules).toEqual([]);
    expect(DEFAULT_PREFERENCES.hiddenModules).toEqual([]);
  });

  it('rejects a language that is not shipped', () => {
    expect(mergePreferences({ language: 'ur' }).language).toBe('en');
  });
});

describe('pickPreferencePatch', () => {
  it('copies only UserPreferences keys', () => {
    expect(pickPreferencePatch({ theme: 'dark', bogus: 1 } as never)).toEqual({
      theme: 'dark',
    });
  });

  it('drops undefined values but keeps an explicit null time zone', () => {
    expect(
      pickPreferencePatch({ theme: undefined, timezone: null } as never),
    ).toEqual({ timezone: null });
  });

  it('is empty for an unknown-only patch', () => {
    expect(pickPreferencePatch({ bogus: 1 } as never)).toEqual({});
  });
});

describe('explicitKeysOf', () => {
  it('is empty for an empty stored object (the user chose nothing)', () => {
    expect(explicitKeysOf({})).toEqual([]);
  });

  it.each([null, undefined, 'dark', 5, [], [1]])(
    'is empty for the non-object %p',
    (stored) => {
      expect(explicitKeysOf(stored)).toEqual([]);
    },
  );

  it('lists only the keys a sparse object holds', () => {
    expect(explicitKeysOf({ weekStart: 'sunday', theme: 'dark' })).toEqual([
      'theme',
      'weekStart',
    ]);
  });

  it('follows the order of the preference keys, not the stored order', () => {
    expect(
      explicitKeysOf({
        composerDefaultWhen: 'draft',
        hiddenModules: [],
        startPage: 'inbox',
        dateFormat: 'YYYY_MM_DD',
        weekStart: 'saturday',
        timeFormat: '24h',
        timezone: 'Asia/Karachi',
        language: 'en',
        theme: 'light',
      }),
    ).toEqual([
      'theme',
      'language',
      'timezone',
      'timeFormat',
      'weekStart',
      'dateFormat',
      'startPage',
      'hiddenModules',
      'composerDefaultWhen',
    ]);
  });

  it('counts a value equal to the default: the user still chose it', () => {
    expect(explicitKeysOf({ weekStart: 'monday', timeFormat: '12h' })).toEqual([
      'timeFormat',
      'weekStart',
    ]);
  });

  it('does not count a stored invalid value', () => {
    expect(
      explicitKeysOf({
        weekStart: 'friday',
        timeFormat: 12,
        theme: 'dark',
        timezone: 'Mars/Olympus',
        hiddenModules: 'inbox',
        dateFormat: null,
      }),
    ).toEqual(['theme']);
  });

  it('ignores unknown keys, explicitKeys itself included', () => {
    expect(
      explicitKeysOf({ bogus: 1, explicitKeys: ['theme'], theme: 'dark' }),
    ).toEqual(['theme']);
  });

  it('counts an explicit null time zone: "follow the device" was chosen', () => {
    expect(explicitKeysOf({ timezone: null })).toEqual(['timezone']);
  });

  it('counts a hiddenModules array even when it holds junk or is empty', () => {
    expect(explicitKeysOf({ hiddenModules: [] })).toEqual(['hiddenModules']);
    expect(explicitKeysOf({ hiddenModules: ['home', 3] })).toEqual([
      'hiddenModules',
    ]);
  });

  it('agrees with mergePreferences: an explicit key is one whose stored value survives', () => {
    const stored = {
      theme: 'dark',
      language: 'en',
      timezone: 'Europe/Paris',
      timeFormat: '24h',
      weekStart: 'saturday',
      dateFormat: 'DD_MM_YYYY',
      startPage: 'planner',
      hiddenModules: ['inbox'],
      composerDefaultWhen: 'best_time',
    };
    const merged = mergePreferences(stored);
    const keys = explicitKeysOf(stored);
    expect(keys).toHaveLength(9);
    for (const key of keys) {
      expect(merged[key]).toEqual(stored[key]);
    }
  });
});

describe('toPreferencesResponse', () => {
  it('is the merged preferences plus explicitKeys', () => {
    expect(
      toPreferencesResponse({ theme: 'dark', weekStart: 'friday' }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      explicitKeys: ['theme'],
    });
  });

  it('keeps the defaults and an empty explicitKeys for an empty object', () => {
    expect(toPreferencesResponse({})).toEqual({
      ...DEFAULT_PREFERENCES,
      explicitKeys: [],
    });
  });
});
