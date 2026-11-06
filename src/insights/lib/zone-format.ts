/**
 * One `Intl.DateTimeFormat` per (zone, options), kept for reuse. Building one
 * costs about 55 µs, so one per post stalls the event loop on a large
 * workspace (10,000 posts: ~560 ms against ~28 ms with the formatter reused).
 *
 * The zones reaching here are validated first (`safeTimeZone`), so the set is
 * small; the cap only guards against a pathological run of distinct zones.
 * The least recently used one goes first.
 */
const MAX_FORMATTERS = 64;

const cache = new Map<string, Intl.DateTimeFormat>();

export function zoneFormatter(
  tz: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so the Map's order is least recently used first.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const made = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
  cache.set(key, made);
  if (cache.size > MAX_FORMATTERS) {
    cache.delete(cache.keys().next().value as string);
  }
  return made;
}

/** For tests: forget every formatter. */
export function clearZoneFormatters(): void {
  cache.clear();
}
