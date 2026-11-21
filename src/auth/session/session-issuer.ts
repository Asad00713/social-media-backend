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
        // Set (or mint) the device cookie so /auth/2fa/verify can trust the
        // same browser it challenged.
        setDeviceCookie(res, cookie.id);
        const challengeToken = await this.challenges.create(
          user.id,
          sha256(cookie.id),
        );
        return { kind: 'mfa', challengeToken };
      }
    }

    // A token from before sessions existed predates two-step sign-in too:
    // with 2FA on, it is refused rather than turned into a new session that
    // never passed the second factor.
    if (!reuse && !CHALLENGING.has(opts.via) && opts.via !== 'two_factor') {
      if (user.totpEnabledAt) throw sessionEnded();
    }

    let sid: string;
    let device: { id: string } | null = null;
    if (reuse) {
      if (!(await this.sessions.touch(reuse, user.id))) throw sessionEnded();
      sid = reuse;
    } else {
      device = readOrMintDeviceId(deviceCookieOf(req.cookies));
      const created = await this.sessions.create({
        userId: user.id,
        deviceHash: sha256(device.id),
        label: deviceLabel(userAgent),
        deviceType: deviceType(userAgent),
        ip,
      });
      sid = created.id;
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
      if (trustHash && trustHash === sha256(device.id)) {
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

    if (RECORDS_ACTIVITY.has(opts.via)) {
      // Awaits the local write only; never throws.
      await this.loginActivity.record(user.id, ip);
    }

    return { kind: 'session', accessToken, sid };
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
