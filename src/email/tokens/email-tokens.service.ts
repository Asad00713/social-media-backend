import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  NOTIFICATION_EVENTS,
  type PreferenceEventKey,
} from '../../notification-preferences/notification-events';

const UNSUBSCRIBE_LABEL = 'email-prefs-tokens';
const UNSUBSCRIBE_AUDIENCE = 'email-unsubscribe';
const SECURITY_LABEL = 'email-security-tokens';
const SECURITY_AUDIENCE = 'email-security';
/** How long a security link works; an email change waits this long too. */
export const SECURITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnsubscribeClaims {
  uid: string;
  ws: string | null;
  ev: PreferenceEventKey;
}

export type SecurityAction = 'revert_email' | 'not_me';

export interface SecurityClaims {
  uid: string;
  act: SecurityAction;
  from?: string;
  to?: string;
}

/**
 * The signed tokens of the email links that carry no login: the unsubscribe
 * link of a notification email and the security links ("this wasn't me",
 * "revert the email change"). The same scheme as ReportTokensService: JWTs
 * with an audience of their own, signed with a key derived from
 * JWT_ACCESS_SECRET under a label of their own, and the algorithm pinned. A
 * login access token (no audience) verifies as neither kind, neither kind
 * verifies as the other, and neither verifies as a report token.
 *
 * An unsubscribe token never expires: an email can sit in an inbox for a year
 * and its stop link must still work. It can only switch off one email of one
 * person in one workspace. A security token is good for 7 days.
 */
@Injectable()
export class EmailTokensService {
  /** The derived keys, computed once per label and secret. */
  private derived = new Map<string, { secret: string; key: string }>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Deterministic per (uid, ws, ev): no iat, so the List-Unsubscribe header of
   * a queued email is byte-identical on every BullMQ attempt. Resend answers a
   * retry that reuses an idempotency key with a different payload with a 409.
   */
  unsubscribeToken(p: UnsubscribeClaims): string {
    return this.jwt.sign(
      { uid: p.uid, ws: p.ws, ev: p.ev },
      {
        secret: this.requireKey(UNSUBSCRIBE_LABEL),
        audience: UNSUBSCRIBE_AUDIENCE,
        noTimestamp: true,
      },
    );
  }

  verifyUnsubscribe(token: string): UnsubscribeClaims | null {
    const p = this.verify(token, UNSUBSCRIBE_LABEL, UNSUBSCRIBE_AUDIENCE);
    if (
      !p ||
      typeof p.uid !== 'string' ||
      !UUID.test(p.uid) ||
      !(p.ws === null || (typeof p.ws === 'string' && UUID.test(p.ws))) ||
      typeof p.ev !== 'string' ||
      !Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, p.ev)
    ) {
      return null;
    }
    return { uid: p.uid, ws: p.ws, ev: p.ev as PreferenceEventKey };
  }

  securityToken(p: SecurityClaims): string {
    return this.jwt.sign(
      {
        uid: p.uid,
        act: p.act,
        ...(p.from !== undefined ? { from: p.from } : {}),
        ...(p.to !== undefined ? { to: p.to } : {}),
      },
      {
        secret: this.requireKey(SECURITY_LABEL),
        audience: SECURITY_AUDIENCE,
        expiresIn: SECURITY_TTL_SECONDS,
      },
    );
  }

  verifySecurity(token: string): SecurityClaims | null {
    const p = this.verify(token, SECURITY_LABEL, SECURITY_AUDIENCE);
    if (
      !p ||
      typeof p.uid !== 'string' ||
      !UUID.test(p.uid) ||
      (p.act !== 'revert_email' && p.act !== 'not_me') ||
      (p.from !== undefined && typeof p.from !== 'string') ||
      (p.to !== undefined && typeof p.to !== 'string')
    ) {
      return null;
    }
    return {
      uid: p.uid,
      act: p.act,
      ...(p.from !== undefined ? { from: p.from } : {}),
      ...(p.to !== undefined ? { to: p.to } : {}),
    };
  }

  private key(label: string): string | null {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) return null;
    const cached = this.derived.get(label);
    if (cached?.secret === secret) return cached.key;
    const key = createHmac('sha256', secret).update(label).digest('base64url');
    this.derived.set(label, { secret, key });
    return key;
  }

  private requireKey(label: string): string {
    const key = this.key(label);
    if (!key) {
      throw new Error(
        'JWT_ACCESS_SECRET is not configured - cannot mint an email token',
      );
    }
    return key;
  }

  private verify(
    token: string,
    label: string,
    audience: string,
  ): Record<string, unknown> | null {
    const secret = this.key(label);
    if (!secret) return null;
    try {
      return this.jwt.verify<Record<string, unknown>>(token, {
        secret,
        audience,
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }
  }
}
