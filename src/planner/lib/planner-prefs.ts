export interface PlannerPrefs {
  postSize: 'comfortable' | 'compact';
  colorBy: 'status' | 'channel' | 'campaign';
  show: {
    media: boolean;
    campaigns: boolean;
    notes: boolean;
    events: boolean;
    weekends: boolean;
  };
  publishedPosts: 'show' | 'fade' | 'hide';
  weekStartsOn: 0 | 1;
  /** `null` means every connected calendar is visible. */
  visibleCalendarIds: string[] | null;
  eventDisplay: 'full' | 'busy';
  bestTimesInWeek: boolean;
  bestTimesSource: 'own' | 'general';
  suggestBestTime: boolean;
}

export const PLANNER_PREF_DEFAULTS: PlannerPrefs = {
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
};

const oneOf =
  (...allowed: readonly unknown[]) =>
  (v: unknown) =>
    allowed.includes(v);
const isBool = (v: unknown) => typeof v === 'boolean';
const isStringArray = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validators for every scalar key; `show` and calendars are handled below. */
const SCALAR_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  postSize: oneOf('comfortable', 'compact'),
  colorBy: oneOf('status', 'channel', 'campaign'),
  publishedPosts: oneOf('show', 'fade', 'hide'),
  weekStartsOn: oneOf(0, 1),
  eventDisplay: oneOf('full', 'busy'),
  bestTimesInWeek: isBool,
  bestTimesSource: oneOf('own', 'general'),
  suggestBestTime: isBool,
};
const SHOW_KEYS = Object.keys(PLANNER_PREF_DEFAULTS.show);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The known, correctly typed part of whatever is stored. Anything else (an
 * unknown key, a wrongly typed value, a non-object document) is dropped.
 * Never throws.
 */
function sanitize(stored: unknown): Record<string, unknown> {
  if (!isRecord(stored)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, valid] of Object.entries(SCALAR_VALIDATORS)) {
    if (valid(stored[key])) out[key] = stored[key];
  }
  if (isStringArray(stored.visibleCalendarIds)) {
    out.visibleCalendarIds = [...stored.visibleCalendarIds];
  }
  if (isRecord(stored.show)) {
    const show: Record<string, boolean> = {};
    for (const key of SHOW_KEYS) {
      if (isBool(stored.show[key])) show[key] = stored.show[key];
    }
    if (Object.keys(show).length > 0) out.show = show;
  }
  return out;
}

/** Stored prefs with defaults filled. Always returns a fresh object. */
export function resolvePrefs(stored: unknown): PlannerPrefs {
  const s = sanitize(stored);
  return {
    ...PLANNER_PREF_DEFAULTS,
    ...s,
    show: {
      ...PLANNER_PREF_DEFAULTS.show,
      ...(s.show as Partial<PlannerPrefs['show']> | undefined),
    },
    visibleCalendarIds: (s.visibleCalendarIds as string[] | undefined) ?? null,
  };
}

/** The patch shape: every field optional; `null` clears visibleCalendarIds. */
export interface PlannerPrefsPatch {
  postSize?: PlannerPrefs['postSize'];
  colorBy?: PlannerPrefs['colorBy'];
  show?: Partial<PlannerPrefs['show']>;
  publishedPosts?: PlannerPrefs['publishedPosts'];
  weekStartsOn?: PlannerPrefs['weekStartsOn'];
  visibleCalendarIds?: string[] | null;
  eventDisplay?: PlannerPrefs['eventDisplay'];
  bestTimesInWeek?: boolean;
  bestTimesSource?: PlannerPrefs['bestTimesSource'];
  suggestBestTime?: boolean;
}

/**
 * Shallow merge of `patch` over the stored document, `show` merged per key.
 * Writes only known, valid keys, so the stored JSON cannot accumulate
 * garbage. `visibleCalendarIds: null` removes the key (all calendars).
 * Pure: neither input is mutated.
 */
export function mergePrefs(
  stored: unknown,
  patch: PlannerPrefsPatch,
): Record<string, unknown> {
  const out = sanitize(stored);
  const incoming = sanitize(patch);
  const show = {
    ...(out.show as object | undefined),
    ...(incoming.show as object | undefined),
  };
  Object.assign(out, incoming);
  if (Object.keys(show).length > 0) out.show = show;
  if (patch.visibleCalendarIds === null) delete out.visibleCalendarIds;
  return out;
}
