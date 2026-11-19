/**
 * The address a deleted account is left with: `deleted+<uuid>@deleted.invalid`
 * (anonymisedEmail in account-deletion.service.ts). `.invalid` is reserved
 * (RFC 2606), so no real address can match.
 */
const ANONYMISED_EMAIL_RE = /^deleted\+[^@\s]+@deleted\.invalid$/i;

/** Whether `email` is the placeholder of a deleted account. */
export function isAnonymisedEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && ANONYMISED_EMAIL_RE.test(email.trim());
}

/**
 * The name to show for a person: their name, else their email, else
 * `fallback`. Null for a deleted account (its name is gone and its email is
 * the placeholder), so the client renders "Deleted user" instead of
 * `deleted+<uuid>@deleted.invalid`.
 */
export function displayNameOrNull(
  name: string | null | undefined,
  email: string | null | undefined,
  fallback: string | null = null,
): string | null {
  if (isAnonymisedEmail(email)) return null;
  return name?.trim() || email?.trim() || fallback;
}
