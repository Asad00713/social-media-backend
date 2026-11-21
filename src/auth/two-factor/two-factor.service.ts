import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { requestClientIp } from '../../common/utils/request-client-ip';
import { encryptTotpSecret } from '../../common/utils/totp-secret.util';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { users } from '../../drizzle/schema/users.schema';
import type { RequestContext } from '../../users/account-security.service';
import { SessionIssuer } from '../session/session-issuer';
import { SessionStore } from '../session/session-store';
import type { JwtUser } from '../strategies/jwt.strategy';
import {
  emailNotVerified,
  mfaAlreadyEnabled,
  mfaNotEnabled,
  mfaSetupMissing,
  reauthRequired,
  wrongPassword,
} from './mfa-errors';
import {
  SecondFactorService,
  type SecondFactorInput,
} from './second-factor.service';
import { TwoFactorNotices } from './two-factor-notices.service';
import { groupSecret, newTotpSecret, totpUrl } from './totp';

/** A Google-only account must have signed in this recently to set up (B2). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  backupCodesRemaining: number;
}

interface Caller {
  userId: string;
  sid: JwtUser['sid'];
}

/**
 * Settings -> Security -> Two-step sign-in (spec §7.2): status, setup,
 * enable, regenerate backup codes, disable. Every change that could weaken
 * the account asks for proof first:
 *   - setup: the password, or for a Google-only account a session that
 *     STARTED within 10 minutes (the session row's created_at, not the
 *     token's iat, which every refresh renews; B2), and a verified address
 *     (batch-2 ruling 2);
 *   - enable: the first code from the new app, against the PENDING secret;
 *   - regenerate: a code or a backup code;
 *   - disable: the password (when there is one) and a code or backup code.
 * Enable and disable sign out every other session; enable re-issues the
 * caller's own (same sid).
 */
@Injectable()
export class TwoFactorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly secondFactor: SecondFactorService,
    private readonly sessions: SessionStore,
    private readonly issuer: SessionIssuer,
    private readonly notices: TwoFactorNotices,
  ) {}

  async status(userId: string): Promise<TwoFactorStatus> {
    const s = await this.secondFactor.status(userId);
    return {
      enabled: s.enabled,
      enabledAt: s.enabledAt ? s.enabledAt.toISOString() : null,
      backupCodesRemaining: s.backupCodesRemaining,
    };
  }

  /**
   * Starts setup: a new secret is stored as PENDING (encrypted) and shown
   * once, as the otpauth URL for the QR code and as a grouped key. Calling
   * it again replaces the pending secret (the old QR stops working).
   */
  async setup(
    caller: Caller,
    dto: { currentPassword?: string },
  ): Promise<{ otpauthUrl: string; secretGrouped: string }> {
    const user = await this.loadUser(caller.userId);
    if (user.totpEnabledAt) throw mfaAlreadyEnabled();
    if (!user.isEmailVerified) throw emailNotVerified();
    if (user.password !== null) {
      await this.assertPassword(user.password, dto.currentPassword);
    } else {
      await this.assertRecentSignIn(caller);
    }

    const secret = newTotpSecret();
    await this.db
      .update(users)
      .set({ totpPendingSecretEnc: encryptTotpSecret(secret) })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)));
    return {
      otpauthUrl: totpUrl(secret, user.email),
      secretGrouped: groupSecret(secret),
    };
  }

  /**
   * Turns two-step sign-in on with the first code from the app. In one
   * transaction: pending -> active, enabled now, ten fresh backup codes,
   * every other session signed out. Then the caller's session is
   * re-issued (same sid, so their current access token stays valid too).
   */
  async enable(
    caller: Caller,
    code: string,
    req: Request,
    res: Response,
  ): Promise<{ backupCodes: string[]; accessToken: string }> {
    // Ruling: enable needs the caller's session row - it is what keeps the
    // caller signed in once every other session ends, and a sid-less token
    // predates sessions (it lives <= 15 min after deploy).
    if (!caller.sid) throw reauthRequired();
    const user = await this.loadUser(caller.userId);
    if (user.totpEnabledAt) throw mfaAlreadyEnabled();
    const pending = user.totpPendingSecretEnc;
    if (!pending) throw mfaSetupMissing();

    await this.secondFactor.check(user.id, { code }, { secret: 'pending' });

    const backupCodes = await this.db.transaction(async (tx) => {
      const promoted = await tx
        .update(users)
        .set({
          totpSecretEnc: pending,
          totpPendingSecretEnc: null,
          totpEnabledAt: new Date(),
        })
        .where(
          and(
            eq(users.id, user.id),
            isNull(users.totpEnabledAt),
            // The secret the code was checked against, not one a second
            // setup in another tab put there since.
            eq(users.totpPendingSecretEnc, pending),
          ),
        )
        .returning({ id: users.id });
      if (promoted.length === 0) throw mfaSetupMissing();
      const codes = await this.secondFactor.replaceBackupCodes(user.id, tx);
      await this.sessions.revokeOthers(user.id, caller.sid, tx);
      return codes;
    });

    const { accessToken } = await this.issuer.issue(user.id, req, res, {
      via: 'two_factor_enable',
      sid: caller.sid,
    });
    void this.notices.enabled(user.id, contextOf(req));
    return { backupCodes, accessToken };
  }

  /** Ten new backup codes; every old one stops working. */
  async regenerate(
    caller: Caller,
    input: SecondFactorInput,
    req: Request,
  ): Promise<{ backupCodes: string[] }> {
    if (!(await this.secondFactor.isEnabled(caller.userId))) {
      throw mfaNotEnabled();
    }
    await this.secondFactor.check(caller.userId, factorOf(input));
    const backupCodes = await this.secondFactor.replaceBackupCodes(
      caller.userId,
    );
    void this.notices.regenerated(caller.userId, contextOf(req));
    return { backupCodes };
  }

  /**
   * Turns two-step sign-in off: the password (when the account has one)
   * first, so a wrong one never costs a second-factor attempt, then a code
   * or backup code. Secret, codes, challenges and trusted devices go, and
   * every other session is signed out.
   */
  async disable(
    caller: Caller,
    dto: SecondFactorInput & { currentPassword?: string },
    req: Request,
  ): Promise<void> {
    const user = await this.loadUser(caller.userId);
    if (!user.totpEnabledAt) throw mfaNotEnabled();
    if (user.password !== null) {
      await this.assertPassword(user.password, dto.currentPassword);
    }
    await this.secondFactor.check(user.id, factorOf(dto));
    await this.db.transaction(async (tx) => {
      await this.secondFactor.clear(user.id, tx);
      await this.sessions.revokeOthers(user.id, caller.sid, tx);
    });
    void this.notices.disabled(user.id, contextOf(req), 'you');
  }

  /** 400 WRONG_PASSWORD (never a 401: the client would replay it). */
  private async assertPassword(
    hash: string,
    current: string | undefined,
  ): Promise<void> {
    if (!current || !(await bcrypt.compare(current, hash))) {
      throw wrongPassword();
    }
  }

  /**
   * A Google-only account has no password to re-enter: its session must
   * have STARTED within the last 10 minutes (B2). The token's iat is no
   * proof - every refresh re-signs it.
   */
  private async assertRecentSignIn(caller: Caller): Promise<void> {
    if (!caller.sid) throw reauthRequired();
    const startedAt = await this.sessions.createdAt(caller.sid, caller.userId);
    if (!startedAt || Date.now() - startedAt.getTime() > REAUTH_WINDOW_MS) {
      throw reauthRequired();
    }
  }

  private async loadUser(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        password: true,
        isEmailVerified: true,
        totpEnabledAt: true,
        totpPendingSecretEnc: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}

/** Only the two factor fields reach the check (never the password). */
function factorOf(input: SecondFactorInput): SecondFactorInput {
  return { code: input.code, backupCode: input.backupCode };
}

function contextOf(req: Request): RequestContext {
  const ua = req.headers?.['user-agent'];
  return {
    ip: requestClientIp(req),
    userAgent: typeof ua === 'string' && ua ? ua : null,
  };
}
