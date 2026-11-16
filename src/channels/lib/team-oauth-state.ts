/**
 * The `additionalData` keys a signed-in (team) OAuth initiate may store in
 * its state. An allowlist, not a denylist: the state also carries keys only
 * the server may write - `connectLinkId` (only the public link start sets
 * it, and a state carrying it acts for that link), `_oauthRedirectUri`
 * (written by OAuthService itself) - and a key added later is kept out
 * until it is named here.
 *
 * `intent` ('connect' | 'ads') picks Facebook's scope set.
 */
export const TEAM_OAUTH_STATE_KEYS: readonly string[] = ['intent'];

/** A team client's `additionalData` with only the allowed keys left. */
export function teamOAuthStateData(
  additionalData: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!additionalData) return out;
  for (const key of TEAM_OAUTH_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(additionalData, key)) {
      out[key] = additionalData[key];
    }
  }
  return out;
}
