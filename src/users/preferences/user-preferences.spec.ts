import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  pickPreferencePatch,
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
