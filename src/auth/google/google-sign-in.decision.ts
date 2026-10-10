import type { GoogleClaims } from './google-claims';

export type GoogleAuthMode = 'popup' | 'redirect';
export type GoogleDoneStatus = 'success' | 'cancelled' | 'error';
export type GoogleRefusalCode =
  | 'EMAIL_UNVERIFIED'
  | 'GOOGLE_ACCOUNT_MISMATCH'
  | 'ACCOUNT_SUSPENDED'
  | 'ADMIN_ACCOUNT';

export interface GoogleCandidate {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  googleSub: string | null;
  isEmailVerified: boolean;
}

export type GoogleSignInDecision =
  | { kind: 'refuse'; code: GoogleRefusalCode }
  | { kind: 'create' }
  | { kind: 'existing'; user: GoogleCandidate; linkSub: boolean };

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

/**
 * Who a Google sign-in belongs to. Matched by `sub` first — it survives the
 * person changing the address on their Google account — then by email, which
 * links a password account the first time its owner chooses Google.
 */
export function decideGoogleSignIn(input: {
  claims: GoogleClaims;
  bySub: GoogleCandidate | null;
  byEmail: GoogleCandidate | null;
}): GoogleSignInDecision {
  const { claims, bySub, byEmail } = input;

  // An unverified Google address proves nothing about the mailbox; linking it
  // to an existing account would hand that account to whoever typed it.
  if (!claims.emailVerified)
    return { kind: 'refuse', code: 'EMAIL_UNVERIFIED' };

  let user = bySub;
  let linkSub = false;

  if (!user && byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) {
      return { kind: 'refuse', code: 'GOOGLE_ACCOUNT_MISMATCH' };
    }
    user = byEmail;
    linkSub = true;
  }

  if (!user) return { kind: 'create' };
  if (!user.isActive) return { kind: 'refuse', code: 'ACCOUNT_SUSPENDED' };
  // Admins sign in through the admin dashboard, behind an emailed second
  // factor. Google here would be a way around it.
  if (ADMIN_ROLES.has(user.role))
    return { kind: 'refuse', code: 'ADMIN_ACCOUNT' };

  return { kind: 'existing', user, linkSub };
}

/** Where the popup (or the full page) lands when the Google round-trip ends. */
export function buildDoneUrl(
  frontendUrl: string,
  result: { status: GoogleDoneStatus; code?: string; mode: GoogleAuthMode },
): string {
  const params = new URLSearchParams({ status: result.status });
  if (result.code) params.set('code', result.code);
  params.set('mode', result.mode);
  return `${frontendUrl.replace(/\/+$/, '')}/auth/google/done?${params.toString()}`;
}
