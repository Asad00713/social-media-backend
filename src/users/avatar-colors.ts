/**
 * The palette an initials avatar is drawn in.
 *
 * A colour is picked once, when the account is created, and stored on the
 * user. It is never recomputed: a person's avatar is how colleagues pick them
 * out of a list, so it has to survive a palette edit, a hashing change, and a
 * rename. Deriving it from the id at render time would tie all three together
 * — change the hash, and everyone's colour changes at once.
 *
 * These are KEYS, not colours. The frontend maps each to a light- and
 * dark-theme pair; sending a hex from here would freeze one theme's palette
 * into the database.
 */
export const AVATAR_COLORS = [
  'amber',
  'blue',
  'emerald',
  'fuchsia',
  'indigo',
  'lime',
  'orange',
  'pink',
  'rose',
  'sky',
  'teal',
  'violet',
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

/**
 * A colour for a new account.
 *
 * Random, not derived from the email or name: a derived colour changes when
 * the user changes their name, and two colleagues with similar names would
 * land on the same one. Random over twelve gives a mixed list, and the value
 * is stored immediately, so "random" happens exactly once per person.
 */
export function pickAvatarColor(): AvatarColor {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

/**
 * A stored colour, or a usable one if the value is missing or unknown.
 *
 * Accounts created before this shipped have no colour, and a palette key can
 * be retired. Neither should render a colourless avatar, so both fall back to
 * the first — deliberately a fixed choice rather than a random one, which
 * would give the same user a different colour on every page load.
 */
export function resolveAvatarColor(
  stored: string | null | undefined,
): AvatarColor {
  return (AVATAR_COLORS as readonly string[]).includes(stored ?? '')
    ? (stored as AvatarColor)
    : AVATAR_COLORS[0];
}
