/**
 * The ways a session can be minted (spec §7.2 "One session issuer").
 *
 * A challenging via starts a sign-in from a first factor (a password, Google,
 * a new account) and may answer `mfa` instead of a session once two-step
 * sign-in is on. A reissue via already holds proof of the second factor — a
 * live `sid`, or a code checked a moment ago — so its overload returns
 * `SessionIssued` only (B6). The guard spec pins each reissue via to the one
 * file that owns it.
 */
export type ChallengingVia = 'register' | 'password' | 'google' | 'admin';
export type ReissueVia =
  | 'refresh'
  | 'password_change'
  | 'two_factor_enable'
  | 'two_factor';

export interface ChallengingOptions {
  via: ChallengingVia;
  /** Record the device without the new-sign-in email (a brand-new account). */
  silentDevice?: boolean;
}

export interface ReissueOptions {
  via: ReissueVia;
  /** The caller's session: reused (same row) when set and live. */
  sid?: string | null;
  /** `two_factor` only: the device hash the challenge was made for. */
  trustDeviceHash?: string | null;
  /**
   * A sid-less (pre-deploy) token's `iat`, in seconds. The session row made
   * for it is dated then (else the epoch), never now: the row is not a
   * sign-in, so it must not pass the Google-only 10-minute re-auth window.
   */
  legacyIssuedAt?: number | null;
}

export interface SessionIssued {
  kind: 'session';
  accessToken: string;
  sid: string;
}

export interface MfaRequired {
  kind: 'mfa';
  challengeToken: string;
}

export type IssueResult = SessionIssued | MfaRequired;

/** The claims on both the access and the refresh token. */
export interface SessionTokenPayload {
  sub: string;
  email: string;
  sid: string;
}
