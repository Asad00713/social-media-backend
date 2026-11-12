import {
  PLATFORM_CONFIG,
  getRefreshTokenTtlDays,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead "expiring" looks on the Channels page. */
export const EXPIRING_WITHIN_DAYS = 7;

/** Connection statuses that only a reconnect fixes. */
const BROKEN_STATUSES: ReadonlySet<string> = new Set([
  'expired',
  'revoked',
  'error',
]);

/** The columns of a channel row the health rules read. */
export interface ChannelHealthInput {
  platform: string;
  isActive: boolean | null;
  pausedAt: Date | null;
  connectionStatus: string | null;
  lastError: string | null;
  tokenExpiresAt: Date | null;
  /** Encrypted or not: only its presence is read. */
  refreshToken: string | null;
  refreshTokenIssuedAt: Date | null;
}

export interface PersonRef {
  id: string;
  name: string;
}

export type ChannelHealthKind =
  | 'ok'
  | 'reconnect'
  | 'expiring'
  | 'paused'
  | 'locked';

export interface ChannelHealth {
  kind: ChannelHealthKind;
  /** For 'expiring': when posting will start failing. */
  expiresAt?: string;
  pausedAt?: string;
  pausedBy?: PersonRef | null;
  /** For 'reconnect': the channel's last error, if it has one. */
  reason?: string | null;
}

/**
 * When the refresh token stops working, or null when it never does (or its
 * age is unknown - a row connected before refresh_token_issued_at existed).
 * Same rule as ChannelResponseDto.refreshTokenExpiresInDays.
 */
export function refreshTokenExpiresAt(
  channel: Pick<
    ChannelHealthInput,
    'platform' | 'refreshToken' | 'refreshTokenIssuedAt'
  >,
): Date | null {
  if (!channel.refreshToken || !channel.refreshTokenIssuedAt) return null;
  const ttlDays = getRefreshTokenTtlDays(channel.platform as SupportedPlatform);
  if (ttlDays === null) return null;
  return new Date(
    new Date(channel.refreshTokenIssuedAt).getTime() + ttlDays * DAY_MS,
  );
}

/**
 * When publishing to this channel starts failing because of its tokens, or
 * null when nothing we know of expires.
 *
 * A channel that can refresh (it holds a refresh token and the platform
 * supports refreshing) keeps working until the refresh token itself dies -
 * or until the access token in hand expires, if that is later. One that
 * cannot refresh dies with its access token; a refresh token it happens to
 * hold (Facebook's long-lived token) bounds that too.
 */
export function postingFailsAt(
  channel: Omit<ChannelHealthInput, 'isActive' | 'pausedAt' | 'lastError'> & {
    connectionStatus?: string | null;
  },
): Date | null {
  const access = channel.tokenExpiresAt
    ? new Date(channel.tokenExpiresAt)
    : null;
  const refresh = refreshTokenExpiresAt(channel);
  const canRefresh =
    !!channel.refreshToken &&
    !!PLATFORM_CONFIG[channel.platform as SupportedPlatform]
      ?.supportsRefreshToken;

  if (canRefresh) {
    if (!refresh) return null;
    return access && access > refresh ? access : refresh;
  }
  if (access && refresh) return access < refresh ? access : refresh;
  return access ?? refresh;
}

/**
 * The single health state a channel card shows. Precedence, strongest first:
 * locked (plan downgrade) > paused (the user's choice) > reconnect (broken
 * status, or tokens already dead) > expiring (tokens die within 7 days) > ok.
 */
export function channelHealth(
  channel: ChannelHealthInput,
  opts: { now?: Date; pausedBy?: PersonRef | null } = {},
): ChannelHealth {
  const now = opts.now ?? new Date();

  if (channel.isActive === false) return { kind: 'locked' };

  if (channel.pausedAt) {
    return {
      kind: 'paused',
      pausedAt: new Date(channel.pausedAt).toISOString(),
      pausedBy: opts.pausedBy ?? null,
    };
  }

  const failsAt = postingFailsAt(channel);

  if (
    BROKEN_STATUSES.has(channel.connectionStatus ?? '') ||
    (failsAt && failsAt.getTime() <= now.getTime())
  ) {
    return { kind: 'reconnect', reason: channel.lastError ?? null };
  }

  if (
    failsAt &&
    failsAt.getTime() <= now.getTime() + EXPIRING_WITHIN_DAYS * DAY_MS
  ) {
    return { kind: 'expiring', expiresAt: failsAt.toISOString() };
  }

  return { kind: 'ok' };
}

/**
 * The `/expiring` rule: the access token OR the refresh token runs out within
 * `days` and has not run out yet. The access-token half is the endpoint's
 * original behaviour, kept as it was; the refresh-token half is what it
 * missed (a YouTube or LinkedIn grant that silently dies at its TTL).
 */
export function isExpiringWithin(
  channel: Pick<
    ChannelHealthInput,
    'platform' | 'tokenExpiresAt' | 'refreshToken' | 'refreshTokenIssuedAt'
  >,
  days: number,
  now: Date = new Date(),
): boolean {
  const from = now.getTime();
  const to = from + days * DAY_MS;
  const inWindow = (d: Date | null): boolean =>
    !!d && d.getTime() > from && d.getTime() <= to;
  return (
    inWindow(
      channel.tokenExpiresAt ? new Date(channel.tokenExpiresAt) : null,
    ) || inWindow(refreshTokenExpiresAt(channel))
  );
}
