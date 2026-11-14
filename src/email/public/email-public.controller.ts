import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { ReportsPublicThrottlerGuard } from '../../insights/reports/reports-public-throttler.guard';
import { NOTIFICATION_EVENTS } from '../../notification-preferences/notification-events';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { AppLinks } from '../links/app-links';
import {
  EmailTokensService,
  type UnsubscribeClaims,
} from '../tokens/email-tokens.service';
import { confirmPage, donePage, invalidLinkPage } from './email-pages';

/** The pages carry no script and load nothing; nothing may frame the button. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** What the GET and the POST both need to know about a verified link. */
interface UnsubscribeTarget {
  label: string;
  /** null for an account-level event. */
  workspaceName: string | null;
}

/**
 * The email routes that need no login. The token in the path is the
 * credential, so each answer is private to the caller and never cached or
 * indexed, and a bad token is always the same plain 404 page, never a 401
 * (the page must not start a token refresh). `@SkipLaunchGate` keeps a
 * signed-in visitor who is not yet allowlisted from being turned away.
 */
@Controller('email')
@SkipLaunchGate()
export class EmailPublicController {
  constructor(
    private readonly tokens: EmailTokensService,
    private readonly prefs: NotificationPreferencesService,
    private readonly links: AppLinks,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  /** Step one: asks, changes nothing, so a link scanner's prefetch is harmless. */
  @Get('unsubscribe/:token')
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmUnsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    this.htmlHeaders(res);
    const claims = this.tokens.verifyUnsubscribe(token);
    if (!claims) return this.html(res, 404, invalidLinkPage());
    if (this.cannotBeTurnedOff(claims)) {
      return this.html(res, 200, this.nothingToTurnOffPage(claims));
    }
    const target = await this.target(claims);
    if (!target) return this.html(res, 404, invalidLinkPage());
    this.html(
      res,
      200,
      confirmPage({
        title: 'Stop these emails?',
        body: `Stop "${target.label}" emails for ${this.where(target)}?`,
        action: `/email/unsubscribe/${token}`,
        button: 'Stop emails',
      }),
    );
  }

  /**
   * Step two, and the RFC 8058 one-click target. The body is never read, so an
   * empty one, `List-Unsubscribe=One-Click` or a multipart one all work, and
   * what is switched off always comes from the verified token. Limited per
   * token: the mailbox providers post from their own servers.
   */
  @Post('unsubscribe/:token')
  @HttpCode(200)
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
      getTracker: (req) =>
        'email-unsub:' + (req.params as { token: string }).token,
    },
  })
  async unsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    this.htmlHeaders(res);
    const claims = this.tokens.verifyUnsubscribe(token);
    if (!claims) return this.html(res, 404, invalidLinkPage());
    if (this.cannotBeTurnedOff(claims)) {
      return this.html(res, 200, this.nothingToTurnOffPage(claims));
    }
    const target = await this.target(claims);
    if (!target) return this.html(res, 404, invalidLinkPage());
    await this.prefs.disableEmail(claims.uid, claims.ws, claims.ev);
    this.html(
      res,
      200,
      donePage({
        title: "You're unsubscribed",
        body: `You won't get "${target.label}" emails for ${this.where(target)} any more.`,
        ...(claims.ws
          ? {
              link: {
                href: this.links.notifications(claims.ws),
                label: 'Manage notifications',
              },
            }
          : {}),
      }),
    );
  }

  /**
   * A locked event (billing, security) or one that never emails has nothing to
   * switch off, and `disableEmail` leaves it alone. Mandatory mail carries no
   * unsubscribe link, so this is only a hand-made or stale token: say so
   * instead of claiming an unsubscribe that did not happen.
   */
  private cannotBeTurnedOff(claims: UnsubscribeClaims): boolean {
    const rule = NOTIFICATION_EVENTS[claims.ev].email;
    return !rule || rule.locked;
  }

  private nothingToTurnOffPage(claims: UnsubscribeClaims): string {
    const { label, email } = NOTIFICATION_EVENTS[claims.ev];
    const copy = email
      ? {
          title: "This email can't be turned off",
          body: `"${label}" emails can't be turned off, so there is nothing to unsubscribe from.`,
        }
      : {
          title: "This notification doesn't send email",
          body: `"${label}" doesn't send email, so there is nothing to unsubscribe from.`,
        };
    return donePage({
      ...copy,
      ...(claims.ws
        ? {
            link: {
              href: this.links.notifications(claims.ws),
              label: 'Manage notifications',
            },
          }
        : {}),
    });
  }

  /** Null when the person or the workspace is gone: the link has nothing to act on. */
  private async target(
    claims: UnsubscribeClaims,
  ): Promise<UnsubscribeTarget | null> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, claims.uid))
      .limit(1);
    if (!user) return null;
    const label = NOTIFICATION_EVENTS[claims.ev].label;
    if (!claims.ws) return { label, workspaceName: null };
    const [ws] = await this.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, claims.ws))
      .limit(1);
    return ws ? { label, workspaceName: ws.name } : null;
  }

  private where(target: UnsubscribeTarget): string {
    return target.workspaceName ?? 'your account';
  }

  private noStore(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  /** First line of an HTML handler, so even a 500 carries them. */
  private htmlHeaders(res: Response): void {
    this.noStore(res);
    res.setHeader('Content-Security-Policy', PAGE_CSP);
  }

  private html(res: Response, status: number, body: string): void {
    res.status(status).type('text/html; charset=utf-8').send(body);
  }
}
