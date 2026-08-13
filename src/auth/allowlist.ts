/**
 * Parses the ALLOWLIST_EMAILS env var (comma-separated) into a normalized
 * lowercase list. An empty result means "gate off" — see isEmailAllowlisted.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/**
 * Launch gate check. The allowlist is an ACCESS gate only — it never grants a
 * role. Returns true (allowed) when the gate is off (empty list), when the
 * caller is a super admin, or when the caller's email is listed. Otherwise
 * false. Reads process.env at call time so a redeploy with a changed var takes
 * effect without code changes.
 */
export function isEmailAllowlisted(
  email: string | undefined | null,
  role: string | undefined,
): boolean {
  const list = parseAllowlist(process.env.ALLOWLIST_EMAILS);
  if (list.length === 0) return true; // gate off
  if (role === 'SUPER_ADMIN') return true;
  if (!email) return false;
  return list.includes(email.trim().toLowerCase());
}
