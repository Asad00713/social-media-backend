import { randomBytes } from 'node:crypto';
import { encrypt, hash } from '../../../common/utils/encryption.util';
import type { ChannelConnectLink } from '../../../drizzle/schema/channel-connect-links.schema';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

/**
 * Pure rules for channel connect links: the token, the derived status, and
 * which networks a link may offer. No database, no Nest.
 */

/**
 * Networks a link may offer: the eight with a standard OAuth login. Bluesky
 * (app password), Mastodon (instance picker), messaging, files and calendars
 * are not offered on a link.
 */
export const CONNECT_LINK_NETWORKS: readonly SupportedPlatform[] = [
  'instagram',
  'facebook',
  'tiktok',
  'linkedin',
  'youtube',
  'pinterest',
  'threads',
  'twitter',
];

/** A link lives 7 days from creation. Resend does not extend it. */
export const CONNECT_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/** Least time between two emails of the same link. */
export const RESEND_COOLDOWN_MS = 60_000;

export type ConnectLinkStatus = 'open' | 'expired' | 'revoked';

/** SHA-256 hex of a raw link token: the only form a lookup compares. */
export function hashLinkToken(raw: string): string {
  return hash(raw);
}

/**
 * A fresh link token: 32 random bytes as base64url (43 chars, 256 bits).
 * `hash` is stored for lookups; `encrypted` lets the sender copy and resend
 * the same URL. (generateSecureToken returns hex, which is longer and a
 * smaller alphabet, so the raw token is generated here.)
 */
export function createLinkToken(): {
  raw: string;
  hash: string;
  encrypted: string;
} {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashLinkToken(raw), encrypted: encrypt(raw) };
}

/** Revoked wins over expired; a link is expired AT expiresAt, not after. */
export function linkStatus(
  link: Pick<ChannelConnectLink, 'expiresAt' | 'revokedAt'>,
  now: Date,
): ConnectLinkStatus {
  if (link.revokedAt) return 'revoked';
  if (now.getTime() >= link.expiresAt.getTime()) return 'expired';
  return 'open';
}

/** The ids a link may not offer, in the order given. */
export function invalidNetworks(networks: string[]): string[] {
  const allowed = new Set<string>(CONNECT_LINK_NETWORKS);
  return networks.filter((n) => !allowed.has(n));
}

/** The public URL a client opens. */
export function linkUrl(raw: string): string {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${frontendUrl}/c/${raw}`;
}
