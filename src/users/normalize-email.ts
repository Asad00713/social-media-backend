/**
 * The one canonical form of an email address in this system: trimmed and
 * lowercased. Every lookup compares against lower(users.email), and every row
 * created from now on is stored in this form. Older rows were stored as typed,
 * which is why lookups lower the column rather than trusting it.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
