/**
 * Where an OAuth callback may send the browser once it is done.
 *
 * The return URL is client-supplied at initiate and stored on the OAuth
 * state, so following it as-is is an open redirect. Only an absolute http(s)
 * URL whose origin is one of ours (`allowedOrigins`, from FRONTEND_URL /
 * APP_URL) is followed. Anything else (another origin, a relative path, a
 * scheme-relative `//host`, userinfo tricks, garbage) gets `fallback`.
 */
export function safeReturnUrl(
  candidate: string | null | undefined,
  fallback: string,
  allowedOrigins: readonly (string | null | undefined)[],
): string {
  if (!candidate || !/^https?:\/\//i.test(candidate)) return fallback;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fallback;
  }
  const allowed = new Set<string>();
  for (const base of allowedOrigins) {
    if (!base) continue;
    try {
      allowed.add(new URL(base).origin);
    } catch {
      // A misconfigured value allows nothing.
    }
  }
  // The parsed form, not the raw string: what was checked is what is used.
  return allowed.has(url.origin) ? url.href : fallback;
}
