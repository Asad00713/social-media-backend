// Hand-rolled on purpose: the `{a|b}` grammar and the order its wordings are
// dealt in are our own publishing rule, and they must agree to the character
// with the composer, which previews them (frontend
// `src/features/composer-v2/lib/caption-variations.ts` and
// `variation-picks.ts`; the spec here uses the same vectors). A spintax
// package would bring nesting and its own ordering, and the preview would no
// longer match what goes out.

/**
 * "Use your variations" on a repeating post.
 *
 * The composer resolves every channel's `{a|b}` groups before it schedules
 * (`withResolvedVariations`), so the stored post holds the wording its FIRST
 * post publishes and the braces are gone. With the Repeat panel's switch on,
 * it also sends each rotating channel's caption WITH its groups, and the
 * variation that first post uses — a `VariationSource`. The series keeps them
 * in `metadata.schedule.recurrence.variations`, and every next post the
 * series creates publishes the next wording (`index + 1`).
 *
 * The rules:
 * - **Order.** `index` counts the caption's combinations with the FIRST group
 *   changing fastest, and wraps after the last (`resolveVariationAt`). Groups
 *   of different lengths are read as one mixed-radix number, so a caption with
 *   a group of 3 and a group of 2 goes through all 6 wordings before any
 *   repeats — not "each group turns by the same index", which would give only
 *   lcm(3, 2) = 6 here but just 2 for two groups of 2 (where 4 exist).
 * - **Start.** A channel's first post uses its place among the post's
 *   platforms (channel 1 → wording 1, channel 2 → wording 2), so channels
 *   still differ on every post of the series.
 * - **A pick wins.** A channel whose wording was picked
 *   (`perPlatform[p].variationPick`) publishes that wording on every post: it
 *   is never a source, and a source sent for it is dropped.
 * - **Per platform**, as `perPlatform` is: two Facebook Pages on one post
 *   publish the same wording.
 */


/** One channel's caption with its groups, as the composer sent it. */
export interface VariationSource {
  /** The caption with its `{a|b}` groups. */
  text: string;
  /** A thread's posts, with their groups, in order. */
  thread?: string[];
  /** The combination THIS post publishes; the next post publishes `+ 1`. */
  index: number;
}

/** Keyed by platform, like `perPlatform`. */
export type VariationSources = Record<string, VariationSource>;


/**
 * The same grammar as the composer: one level, no `}` inside a choice, and
 * at least one `|` — `{hello}` is left alone.
 */
const GROUP_RE = /\{([^{}|]*\|[^{}]*)\}/g;

export const VARIATION_SOURCE_LIMITS = {
  /** Above every platform's caption limit (Facebook's 63,206 is the largest). */
  text: 70_000,
  /** Thread posts per channel. */
  thread: 50,
  /** Far past any series: 100 posts × 12 channels. */
  index: 1_000_000,
} as const;


function groupsOf(caption: string): string[][] {
  return [...caption.matchAll(GROUP_RE)].map((m) => m[1].split('|'));
}

/** Whether `caption` holds any `{a|b}` group. */
export function hasVariations(caption: string): boolean {
  return groupsOf(caption).length > 0;
}

/**
 * The `k`-th wording of `caption`: `k` read as a mixed-radix number over the
 * groups' option counts, first group fastest, wrapping past the last
 * combination. The composer's `resolveVariationAt`, character for character.
 */
export function resolveVariationAt(caption: string, k: number): string {
  let rest = Math.max(0, Math.floor(k));
  let out = '';
  let last = 0;
  for (const match of caption.matchAll(GROUP_RE)) {
    const options = match[1].split('|');
    out += caption.slice(last, match.index);
    out += options[rest % options.length];
    rest = Math.floor(rest / options.length);
    last = match.index + match[0].length;
  }
  return out + caption.slice(last);
}

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= VARIATION_SOURCE_LIMITS.text;

/** Whether a channel's wording was picked, which pins it for the series. */
function isPicked(perPlatform: unknown, platform: string): boolean {
  const pick = (
    (perPlatform as Record<string, { variationPick?: unknown }> | undefined)?.[
      platform
    ] ?? {}
  ).variationPick;
  return Number.isInteger(pick) && (pick as number) >= 0;
}

/**
 * The sources worth keeping, or null when `v` is not a sources object at all.
 *
 * Dropped, not refused: a platform the post is not on (`platforms`, when
 * given), a channel whose wording is picked, and a source with no group
 * anywhere — there is nothing to rotate. A malformed entry (wrong types, past
 * the limits) makes the whole value null, so the caller can refuse it.
 */
export function parseVariationSources(
  v: unknown,
  opts: { platforms?: readonly string[]; perPlatform?: unknown } = {},
): VariationSources | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: VariationSources = {};
  for (const [platform, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (!isText(s.text)) return null;
    if (
      !Number.isInteger(s.index) ||
      (s.index as number) < 0 ||
      (s.index as number) > VARIATION_SOURCE_LIMITS.index
    ) {
      return null;
    }
    let thread: string[] | undefined;
    if (s.thread !== undefined) {
      if (
        !Array.isArray(s.thread) ||
        s.thread.length > VARIATION_SOURCE_LIMITS.thread ||
        !s.thread.every(isText)
      ) {
        return null;
      }
      thread = s.thread;
    }
    if (opts.platforms && !opts.platforms.includes(platform)) continue;
    if (isPicked(opts.perPlatform, platform)) continue;
    if (!hasVariations(s.text) && !thread?.some(hasVariations)) continue;
    out[platform] = {
      text: s.text,
      ...(thread ? { thread } : {}),
      index: s.index as number,
    };
  }
  return out;
}

/** The sources one post on: every channel moves to its next wording. */
export function advanceSources(sources: VariationSources): VariationSources {
  return Object.fromEntries(
    Object.entries(sources).map(([platform, s]) => [
      platform,
      { ...s, index: s.index + 1 },
    ]),
  );
}

interface RotatableRow {
  platformContent?: unknown;
  metadata?: unknown;
}

/**
 * The row's per-channel content with each source's wording at its `index`
 * written in: `overrides.text` (which the publish paths prefer over the base),
 * each thread post's `text`, and — for X — the `metadata.thread` copy the
 * Twitter publisher reads. Everything else is left as it was.
 */
export function applyVariationSources<T extends RotatableRow>(
  row: T,
  sources: VariationSources,
): T {
  const platformContent: Record<string, any> = {
    ...((row.platformContent ?? {}) as Record<string, any>),
  };
  const metadata: Record<string, any> = {
    ...((row.metadata ?? {}) as Record<string, any>),
  };
  for (const [platform, source] of Object.entries(sources)) {
    const entry = platformContent[platform] ?? {
      inheritsFromBase: true,
      overrides: {},
      platformSpecific: {},
    };
    const next = {
      ...entry,
      overrides: {
        ...(entry.overrides ?? {}),
        text: resolveVariationAt(source.text, source.index),
      },
    };
    const stored = entry.platformSpecific?.thread;
    if (source.thread && Array.isArray(stored)) {
      const thread = stored.map((post: Record<string, unknown>, i: number) =>
        i < source.thread!.length
          ? { ...post, text: resolveVariationAt(source.thread![i], source.index) }
          : post,
      );
      next.platformSpecific = { ...entry.platformSpecific, thread };
      if (platform === 'twitter' && Array.isArray(metadata.thread)) {
        metadata.thread = thread;
      }
    }
    platformContent[platform] = next;
  }
  return { ...row, platformContent, metadata };
}
