import { isIanaTimeZone } from '../../common/validators/is-iana-time-zone';

export const THEMES = ['light', 'dark', 'system'] as const;
/** Shipped locales only; the field exists so more can be added later. */
export const LANGUAGES = ['en'] as const;
export const TIME_FORMATS = ['12h', '24h'] as const;
export const WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export const DATE_FORMATS = [
  'D_MMM_YYYY',
  'MMM_D_YYYY',
  'DD_MM_YYYY',
  'YYYY_MM_DD',
] as const;
export const START_PAGES = ['home', 'planner', 'inbox', 'last'] as const;
/** Home and Planner always stay, so they are not hideable. */
export const HIDEABLE_MODULES = [
  'inbox',
  'campaigns',
  'insights',
  'library',
] as const;
export const COMPOSER_DEFAULT_WHEN = [
  'best_time',
  'next_free_slot',
  'draft',
] as const;

/** The per-user Preferences page (spec 5.4). */
export interface UserPreferences {
  theme: (typeof THEMES)[number];
  language: (typeof LANGUAGES)[number];
  /** IANA id; null = follow the device. */
  timezone: string | null;
  timeFormat: (typeof TIME_FORMATS)[number];
  weekStart: (typeof WEEK_STARTS)[number];
  dateFormat: (typeof DATE_FORMATS)[number];
  startPage: (typeof START_PAGES)[number];
  hiddenModules: Array<(typeof HIDEABLE_MODULES)[number]>;
  composerDefaultWhen: (typeof COMPOSER_DEFAULT_WHEN)[number];
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'system',
  language: 'en',
  timezone: null,
  timeFormat: '12h',
  weekStart: 'monday',
  dateFormat: 'D_MMM_YYYY',
  startPage: 'home',
  hiddenModules: [],
  // What Schedule does today with no time picked: save a draft.
  composerDefaultWhen: 'draft',
};

const PREFERENCE_KEYS = Object.keys(DEFAULT_PREFERENCES) as Array<
  keyof UserPreferences
>;

const oneOf = <T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && allowed.includes(value as T);

/**
 * The stored sparse object over the defaults. Unknown keys and invalid values
 * are dropped (the default stands in), so a bad stored value never reaches
 * the client.
 */
export function mergePreferences(stored: unknown): UserPreferences {
  const s: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const d = DEFAULT_PREFERENCES;
  return {
    theme: oneOf(THEMES, s.theme) ? s.theme : d.theme,
    language: oneOf(LANGUAGES, s.language) ? s.language : d.language,
    timezone:
      typeof s.timezone === 'string' && isIanaTimeZone(s.timezone)
        ? s.timezone
        : d.timezone,
    timeFormat: oneOf(TIME_FORMATS, s.timeFormat) ? s.timeFormat : d.timeFormat,
    weekStart: oneOf(WEEK_STARTS, s.weekStart) ? s.weekStart : d.weekStart,
    dateFormat: oneOf(DATE_FORMATS, s.dateFormat) ? s.dateFormat : d.dateFormat,
    startPage: oneOf(START_PAGES, s.startPage) ? s.startPage : d.startPage,
    hiddenModules: Array.isArray(s.hiddenModules)
      ? [...new Set(s.hiddenModules)].filter(
          (m): m is (typeof HIDEABLE_MODULES)[number] =>
            oneOf(HIDEABLE_MODULES, m),
        )
      : [...d.hiddenModules],
    composerDefaultWhen: oneOf(COMPOSER_DEFAULT_WHEN, s.composerDefaultWhen)
      ? s.composerDefaultWhen
      : d.composerDefaultWhen,
  };
}

/**
 * Whether a stored value is one {@link mergePreferences} would keep, per key.
 * A time zone of `null` counts: the PATCH stores it to say "follow the
 * device", which is a choice. A hiddenModules array counts whatever it
 * holds, because merge keeps the array and filters its items.
 */
const IS_STORED_VALUE_VALID: Record<
  keyof UserPreferences,
  (value: unknown) => boolean
> = {
  theme: (v) => oneOf(THEMES, v),
  language: (v) => oneOf(LANGUAGES, v),
  timezone: (v) => v === null || (typeof v === 'string' && isIanaTimeZone(v)),
  timeFormat: (v) => oneOf(TIME_FORMATS, v),
  weekStart: (v) => oneOf(WEEK_STARTS, v),
  dateFormat: (v) => oneOf(DATE_FORMATS, v),
  startPage: (v) => oneOf(START_PAGES, v),
  hiddenModules: (v) => Array.isArray(v),
  composerDefaultWhen: (v) => oneOf(COMPOSER_DEFAULT_WHEN, v),
};

/**
 * The preference keys the user actually set: present in the stored sparse
 * object AND valid (the same rules as {@link mergePreferences}). A key the
 * user never chose, or one holding a bad stored value, is not explicit, so a
 * client can fill it from the browser instead of the server's default. In
 * `PREFERENCE_KEYS` order.
 */
export function explicitKeysOf(stored: unknown): Array<keyof UserPreferences> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return [];
  }
  const s = stored as Record<string, unknown>;
  return PREFERENCE_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(s, key) &&
      IS_STORED_VALUE_VALID[key](s[key]),
  );
}

/** What the preferences routes return: every value, plus which were chosen. */
export type UserPreferencesResponse = UserPreferences & {
  explicitKeys: Array<keyof UserPreferences>;
};

export function toPreferencesResponse(
  stored: unknown,
): UserPreferencesResponse {
  return { ...mergePreferences(stored), explicitKeys: explicitKeysOf(stored) };
}

/**
 * Only the {@link UserPreferences} keys of a patch, `undefined` values
 * dropped. An explicit `null` (the time zone) is kept: it means "follow the
 * device" and must be stored.
 */
export function pickPreferencePatch(
  patch: Partial<UserPreferences>,
): Partial<UserPreferences> {
  const out: Record<string, unknown> = {};
  for (const key of PREFERENCE_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(patch, key) &&
      patch[key] !== undefined
    ) {
      out[key] = patch[key];
    }
  }
  return out as Partial<UserPreferences>;
}
