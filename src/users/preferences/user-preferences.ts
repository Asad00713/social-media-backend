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
