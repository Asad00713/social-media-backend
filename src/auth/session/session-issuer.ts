import { createHash } from 'crypto';
import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { requestClientIp } from '../../common/utils/request-client-ip';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { users } from '../../drizzle/schema/users.schema';
import {
  deviceCookieOf,
  readOrMintDeviceId,
  setDeviceCookie,
} from '../devices/device-cookie';
import { deviceLabel, deviceType } from '../devices/device-label';
import { KnownDevicesService } from '../devices/known-devices.service';
import { setRefreshCookie } from '../refresh-cookie';
import { GeoipService } from '../services/geoip.service';
import { LoginActivityService } from '../services/login-activity.service';
import { MfaChallengeService } from '../two-factor/mfa-challenge.service';
import { SessionStore } from './session-store';
import { assertNotDeleted } from '../strategies/jwt.strategy';
import type {
  ChallengingOptions,
  IssueResult,
  ReissueOptions,
  SessionIssued,
  SessionTokenPayload,
} from './session.types';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';

/** Vias whose sign-in is recorded as last-seen here. */
const RECORDS_ACTIVITY = new Set([
  'password',
  'admin',
  'refresh',
  'two_factor',
]);
/** Reissue vias that keep the caller's row when it has one. */
const REUSES_SID = new Set(['refresh', 'password_change', 'two_factor_enable']);
/** Vias that start from a first factor and so may be challenged (B6). */
const CHALLENGING = new Set(['register', 'password', 'google', 'admin']);

interface Signer {
  access: string;
  refresh: string;
}

interface IssuerUser {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  deletedAt: Date | null;
  suspendedReason: string | null;
  totpEnabledAt: Date | null;
}

/**
 * The only code that mints a session (spec §7.2 "One session issuer"): it
 * signs the access and refresh JWTs, writes the `user_sessions` row behind
 * their `sid` and sets the refresh cookie. Register, password login, the
 * Google callback, refresh and password change all come through `issue`;
 * `session-issuer.guard.spec.ts` fails if anything else signs a session
 * token or sets the cookie. Two-step sign-in is enforced here (a later task),
 * so a path that bypassed the issuer would bypass the second factor.
 *
 * Order, for a new session: secrets resolved (a missing one fails before any
 * write) → row → tokens → refresh cookie → device cookie and the detached
 * device sighting (A6) → detached GeoIP country → last-seen. A device is
 * only recorded once the session exists, so a failed sign-in leaves none.
 * For a reused session: `touch` first; a revoked or idle row is a 401
 * before any cookie is set.
 */
@Injectable()
export class SessionIssuer {
  private readonly logger = new Logger(SessionIssuer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: SessionStore,
    private readonly knownDevices: KnownDevicesService,
    private readonly loginActivity: LoginActivityService,
    private readonly geoip: GeoipService,
    private readonly challenges: MfaChallengeService,
  ) {}

  issue(
    userId: string,
    req: Request,
    res: Response,
    opts: ChallengingOptions,
  ): Promise<IssueResult>;
  issue(
    userId: string,
    req: Request,
    res: Response,
    opts: ReissueOptions,
  ): Promise<SessionIssued>;
  async issue(
    userId: string,
    req: Request,
    res: Response,
    opts: ChallengingOptions | ReissueOptions,
  ): Promise<IssueResult> {
    const secrets = this.secrets();
    const user = await this.loadUser(userId);
    const ip = requestClientIp(req);
    const userAgent = userAgentOf(req);

    const reuse =
      REUSES_SID.has(opts.via) && 'sid' in opts && opts.sid ? opts.sid : null;

    // Two-step sign-in (spec §7.2): a first factor on an untrusted device
    // mints NOTHING - no row, no refresh cookie, no device sighting, no
    // last-seen - and answers a challenge bound to this browser instead.
    if (CHALLENGING.has(opts.via) && user.totpEnabledAt) {
      const cookie = readOrMintDeviceId(deviceCookieOf(req.cookies));
      if (!(await this.isTrusted(user, cookie, opts.via))) {
        return this.challenge(user.id, res, cookie.id);
      }
    }

    // A token from before sessions existed predates two-step sign-in too:
    // with 2FA on, it is refused rather than turned into a new session that
    // never passed the second factor.
    if (!reuse && !CHALLENGING.has(opts.via) && opts.via !== 'two_factor') {
      if (user.totpEnabledAt) throw sessionEnded();
    }

    // The second factor finishes a sign-in begun up to 5 minutes ago: an
    // account suspended or deleted since gets nothing, as the strategies
    // would refuse it on the next request anyway.
    if (opts.via === 'two_factor') assertSignInAllowed(user);

    // A suspended account's refresh (final review finding 9, ruled): it must
    // not look active - no `touch` (last_used_at, idle expiry) and no
    // last-seen - so "Last active" and the admin's last use stay frozen at
    // the suspension. A live sid still gets its access token back, which
    // every consumer refuses with ACCOUNT_SUSPENDED: that 401 is what sends
    // the FE to its suspension screen (a refused refresh would show "session
    // expired" instead). A sid-less refresh would need a NEW row, so it is
    // refused outright (assertSignInAllowed: ACCOUNT_SUSPENDED, no row).
    const suspendedRefresh = opts.via === 'refresh' && !user.isActive;
    if (suspendedRefresh && !reuse) assertSignInAllowed(user);

    let sid: string;
    let device: { id: string } | null = null;
    if (reuse) {
      const live = suspendedRefresh
        ? await this.sessions.isLive(reuse, user.id)
        : await this.sessions.touch(reuse, user.id);
      if (!live) throw sessionEnded();
      sid = reuse;
    } else {
      device = readOrMintDeviceId(deviceCookieOf(req.cookies));
      const row = {
        userId: user.id,
        deviceHash: sha256(device.id),
        label: deviceLabel(userAgent),
        deviceType: deviceType(userAgent),
        ip,
        createdAt: legacyStart(opts),
      };
      // Read "2FA off", so not challenged: the row is inserted only if it is
      // still off (final review finding 6). An enable that committed in
      // between gets a challenge (a sign-in) or a refusal (a sid-less
      // reissue, which with 2FA on is refused above) - never a session that
      // skipped the second factor. The second factor's own via has passed it.
      if (!user.totpEnabledAt && opts.via !== 'two_factor') {
        const created = await this.sessions.createIfTwoFactorOff(row);
        if (!created) {
          if (CHALLENGING.has(opts.via)) {
            return this.challenge(user.id, res, device.id);
          }
          throw sessionEnded();
        }
        sid = created.id;
      } else {
        sid = (await this.sessions.create(row)).id;
      }
    }

    const payload: SessionTokenPayload = {
      sub: user.id,
      email: user.email,
      sid,
    };
    const accessToken = this.signAccess(payload, secrets);
    setRefreshCookie(res, this.signRefresh(payload, secrets));

    if (device) {
      setDeviceCookie(res, device.id);
      const trustHash =
        opts.via === 'two_factor' && 'trustDeviceHash' in opts
          ? opts.trustDeviceHash
          : null;
      // Never for a super admin: their trust is never honoured (B5), and a
      // row would skip TOTP for 30 days if the account were demoted.
      if (
        trustHash &&
        trustHash === sha256(device.id) &&
        user.role !== 'SUPER_ADMIN'
      ) {
        // The code was just checked on the browser the challenge was made
        // for: trust it for 30 days. Awaited (R9); this upsert is also the
        // sign-in's device sighting and sends A6 itself (B4), so track()
        // must not run - it would read the fresh row as "known".
        await this.knownDevices.markMfaTrusted(user.id, device.id, {
          ip,
          userAgent,
        });
      } else {
        this.knownDevices.track(
          user.id,
          device.id,
          { ip, userAgent },
          { silent: this.silentDevice(opts) },
        );
      }
      this.resolveCountry(sid, ip);
    }

    if (RECORDS_ACTIVITY.has(opts.via) && !suspendedRefresh) {
      // Awaits the local write only; never throws.
      await this.loginActivity.record(user.id, ip);
    }

    return { kind: 'session', accessToken, sid };
  }

  /**
   * Mints nothing: a challenge bound to this browser. The device cookie is
   * set (or minted) so /auth/2fa/verify can trust the browser it challenged.
   */
  private async challenge(
    userId: string,
    res: Response,
    deviceId: string,
  ): Promise<IssueResult> {
    setDeviceCookie(res, deviceId);
    const challengeToken = await this.challenges.create(
      userId,
      sha256(deviceId),
    );
    return { kind: 'mfa', challengeToken };
  }

  /**
   * Trusted = a real `sd_device` cookie (a minted one never is, R9) whose
   * known_devices row has `mfa_trusted_until` ahead. A super admin is never
   * trusted: the emailed code and TOTP are both asked every time (B5). A
   * brand-new account (register) has no trust to inherit.
   */
  private async isTrusted(
    user: IssuerUser,
    cookie: { id: string; isNew: boolean },
    via: string,
  ): Promise<boolean> {
    if (cookie.isNew || user.role === 'SUPER_ADMIN' || via === 'register') {
      return false;
    }
    return this.knownDevices.isMfaTrusted(user.id, cookie.id);
  }

  private silentDevice(opts: ChallengingOptions | ReissueOptions): boolean {
    // A brand-new account's first browser, and a session made for an
    // existing token (a pre-deploy refresh token, a sid-less caller) are not
    // new sign-ins, so they never send the new-sign-in email.
    if (opts.via === 'register') return true;
    if (
      opts.via === 'password' ||
      opts.via === 'google' ||
      opts.via === 'admin'
    ) {
      return opts.silentDevice ?? false;
    }
    return opts.via !== 'two_factor';
  }

  /** Detached: a slow or failing lookup never holds up or fails a sign-in. */
  private resolveCountry(sid: string, ip: string | null): void {
    void this.geoip
      .lookup(ip)
      .then((geo) =>
        geo ? this.sessions.setCountry(sid, geo.country ?? null) : undefined,
      )
      .catch((error: unknown) => {
        this.logger.debug(
          `Session country lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
  }

  private async loadUser(userId: string): Promise<IssuerUser> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        suspendedReason: true,
        totpEnabledAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  private secrets(): Signer {
    const access = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!access) throw new Error('JWT_ACCESS_SECRET is not defined');
    const refresh = this.config.get<string>('JWT_REFRESH_SECRET');
    if (!refresh) throw new Error('JWT_REFRESH_SECRET is not defined');
    return { access, refresh };
  }

  private signAccess(payload: SessionTokenPayload, secrets: Signer): string {
    return this.jwt.sign(payload, {
      secret: secrets.access,
      expiresIn: ACCESS_TTL,
    });
  }

  private signRefresh(payload: SessionTokenPayload, secrets: Signer): string {
    return this.jwt.sign(payload, {
      secret: secrets.refresh,
      expiresIn: REFRESH_TTL,
    });
  }
}

/**
 * The date a new row stands for. A sign-in (a challenging via, or the second
 * factor that completes one) is now: undefined, the database default. Any
 * other via only gets here without a sid - a pre-deploy token - and is
 * dated at that token's iat, else the epoch, so it never passes for a fresh
 * sign-in (batch-3 review finding 1).
 */
function legacyStart(
  opts: ChallengingOptions | ReissueOptions,
): Date | undefined {
  if (CHALLENGING.has(opts.via) || opts.via === 'two_factor') return undefined;
  const iat = 'legacyIssuedAt' in opts ? opts.legacyIssuedAt : null;
  return new Date(typeof iat === 'number' && iat > 0 ? iat * 1000 : 0);
}

/** The same refusals as the access strategy, deleted before suspended. */
function assertSignInAllowed(user: IssuerUser): void {
  assertNotDeleted(user.deletedAt);
  if (!user.isActive) {
    throw new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'ACCOUNT_SUSPENDED',
      reason: user.suspendedReason ?? 'manual',
      message: 'Your account has been suspended.',
    });
  }
}

function sessionEnded(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'SESSION_ENDED',
    message: 'Session ended',
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function userAgentOf(req: Request): string | null {
  const ua = req.headers?.['user-agent'];
  return typeof ua === 'string' && ua ? ua : null;
}
