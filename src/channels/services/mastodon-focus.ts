/**
 * A photo's focal point as Mastodon's `focus` upload parameter.
 *
 * The composer saves the point on the media item as fractions of the picture,
 * 0 to 1 from the TOP LEFT (`{ x: 0.2, y: 0.8 }` is a fifth of the way in and
 * near the bottom). Mastodon documents `focus` as "Two floating points (x,y),
 * comma-delimited, ranging from -1.0 to 1.0", with the floats running
 * "left-to-right or bottom-to-top" and (0,0) at the centre
 * (docs.joinmastodon.org/methods/media and /api/guidelines#focal-points).
 *
 * So x maps linearly onto -1..1, and y is FLIPPED: the top of the picture
 * (our 0) is Mastodon's +1. Getting that backwards focuses the sky when
 * someone picked the ground, and the mistake is invisible until a real post
 * crops wrongly — which is why the three corners are pinned in the spec.
 *
 * Returns `undefined` for anything that is not a point inside the picture, so
 * a malformed value in a stored draft leaves the upload without a `focus`
 * (Mastodon then centres) rather than sending a number it would reject. The
 * input is untyped on purpose: it arrives as JSON from a draft.
 */
export function toMastodonFocus(point: unknown): string | undefined {
  if (!point || typeof point !== 'object') return undefined;
  const { x, y } = point as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;

  return `${round(x * 2 - 1)},${round((1 - y) * 2 - 1)}`;
}

/**
 * Two decimals, as the composer rounds its own copy. Also keeps `-0` from
 * printing as "-0": a template string renders it as "0".
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
