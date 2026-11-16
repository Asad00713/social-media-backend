import {
  PLATFORM_CONFIG,
  getRefreshTokenTtlDays,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import {
  CHANNEL_RESTORE_WINDOW_MS,
  mustDeleteOnDisconnect,
} from './disconnect-policy';

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
  /** When `lastError` was recorded; read only for `since`. */
  lastErrorAt?: Date | null;
  tokenExpiresAt: Date | null;
  /** Encrypted or not: only its presence is read. */
  refreshToken: string | null;
  refreshTokenIssuedAt: Date | null;
  /** Soft disconnect (0081); absent on callers that predate it. */
  disconnectedAt?: Date | null;
  disconnectFinalizedAt?: Date | null;
}

export interface PersonRef {
  id: string;
  name: string;
}

export type ChannelHealthKind =
  | 'disconnected'
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
  /**
   * For 'reconnect': when that error was recorded (`last_error_at`). Absent
   * when unknown - a token that simply ran out records no error.
   */
  since?: string;
  /** For 'disconnected': when it was disconnected. */
  disconnectedAt?: string;
  /** For 'disconnected': until when the disconnect can be undone; null once it cannot. */
  restoreUntil?: string | null;
  /**
   * For 'disconnected': false when the platform's policy deletes its history
   * when the undo window closes (it is then deleted at `restoreUntil`).
   */
  historyKept?: boolean;
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
  channel: Omit<
    ChannelHealthInput,
    'isActive' | 'pausedAt' | 'lastError' | 'lastErrorAt'
  > & {
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

  // Disconnected first: it is history, whatever else is true of the row.
  if (channel.connectionStatus === 'disconnected' && channel.disconnectedAt) {
    const until = new Date(
      new Date(channel.disconnectedAt).getTime() + CHANNEL_RESTORE_WINDOW_MS,
    );
    const canUndo =
      !channel.disconnectFinalizedAt && until.getTime() > now.getTime();
    return {
      kind: 'disconnected',
      disconnectedAt: new Date(channel.disconnectedAt).toISOString(),
      restoreUntil: canUndo ? until.toISOString() : null,
      historyKept: !mustDeleteOnDisconnect(channel.platform),
    };
  }

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
    return {
      kind: 'reconnect',
      reason: channel.lastError ?? null,
      ...(channel.lastErrorAt
        ? { since: new Date(channel.lastErrorAt).toISOString() }
        : {}),
    };
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
