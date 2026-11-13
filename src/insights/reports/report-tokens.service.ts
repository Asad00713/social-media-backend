import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

const RENDER_AUDIENCE = 'report-render';
const UNSUBSCRIBE_AUDIENCE = 'report-unsubscribe';
const RENDER_TTL_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signed tokens of the report routes that carry no login. Both are JWTs
 * under JWT_ACCESS_SECRET, each with its own audience, so a login access token
 * (no audience) verifies as neither, and neither kind verifies as the other.
 * The algorithm is pinned: a token that names `none` or another one is refused.
 */
@Injectable()
export class ReportTokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** What `ReportsService.newShareToken` writes: 32 random bytes, base64url. */
  static isShareToken(t: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(t);
  }

  /**
   * For the PDF job to open the print page: five minutes, long enough to
   * render. It outlives a share link turned off by at most that much.
   */
  renderToken(reportId: string): string {
    return this.jwt.sign(
      { rid: reportId },
      {
        secret: this.requireSecret(),
        audience: RENDER_AUDIENCE,
        expiresIn: RENDER_TTL_SECONDS,
      },
    );
  }

  verifyRender(token: string): string | null {
    const p = this.verify(token, RENDER_AUDIENCE);
    return p && typeof p.rid === 'string' && UUID.test(p.rid) ? p.rid : null;
  }

  /**
   * One per recipient, with no expiry: an email can sit in an inbox for a year
   * and its stop link must still work. It can only ever remove the one address
   * it names, so a leaked link costs its owner a report they asked to stop.
   */
  unsubscribeToken(reportId: string, email: string): string {
    return this.jwt.sign(
      { rid: reportId, email },
      { secret: this.requireSecret(), audience: UNSUBSCRIBE_AUDIENCE },
    );
  }

  verifyUnsubscribe(token: string): { reportId: string; email: string } | null {
    const p = this.verify(token, UNSUBSCRIBE_AUDIENCE);
    if (
      !p ||
      typeof p.rid !== 'string' ||
      !UUID.test(p.rid) ||
      typeof p.email !== 'string' ||
      !p.email
    ) {
      return null;
    }
    return { reportId: p.rid, email: p.email };
  }

  private requireSecret(): string {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error(
        'JWT_ACCESS_SECRET is not configured - cannot mint a report token',
      );
    }
    return secret;
  }

  private verify(
    token: string,
    audience: string,
  ): Record<string, unknown> | null {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
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
