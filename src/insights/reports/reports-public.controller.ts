import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import {
  confirmUnsubscribePage,
  invalidUnsubscribePage,
  unsubscribedPage,
} from './lib/report-pages';
import {
  ReportsPublicThrottlerGuard,
  unsubscribeTokenTracker,
} from './reports-public-throttler.guard';
import type { ReportPayloadDto } from './reports.dto';
import { ReportsService } from './reports.service';

/** The pages carry no script and load nothing; nothing may frame the button. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/**
 * The report routes that need no login: the public link, the print page's
 * data, and the unsubscribe link in a report email. The token in the path is
 * the credential, so each answer is private to the caller and never cached or
 * indexed, and a bad token is always a plain 404, never a 401 (the page must
 * not start a token refresh). `@SkipLaunchGate` keeps a signed-in visitor who
 * is not yet allowlisted from being turned away.
 */
@Controller('reports')
@SkipLaunchGate()
export class ReportsPublicController {
  constructor(private readonly reports: ReportsService) {}

  @Get('public/:token')
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  publicReport(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportPayloadDto> {
    this.noStore(res);
    return this.reports.publicPayload(token);
  }

  @Get('render/:token')
  render(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportPayloadDto> {
    this.noStore(res);
    return this.reports.renderPayload(token);
  }

  /** Step one: asks, changes nothing, so a link scanner's prefetch is harmless. */
  @Get('unsubscribe/:token')
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmUnsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    this.htmlHeaders(res);
    const target = await this.reports.unsubscribeTarget(token);
    if (!target) return this.html(res, 404, invalidUnsubscribePage());
    this.html(
      res,
      200,
      confirmUnsubscribePage(
        target.reportName,
        `/reports/unsubscribe/${token}`,
      ),
    );
  }

  /**
   * Step two, and the RFC 8058 one-click target. The body is never read, so an
   * empty one, `List-Unsubscribe=One-Click` or a multipart one all work, and
   * the address always comes from the verified token. Limited per token: the
   * mailbox providers post from their own servers.
   */
  @Post('unsubscribe/:token')
  @HttpCode(200)
  @UseGuards(ReportsPublicThrottlerGuard)
  @Throttle({
    default: { limit: 10, ttl: 60_000, getTracker: unsubscribeTokenTracker },
  })
  async unsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    this.htmlHeaders(res);
    const done = await this.reports.unsubscribe(token);
    if (!done) return this.html(res, 404, invalidUnsubscribePage());
    this.html(res, 200, unsubscribedPage(done.reportName));
  }

  private noStore(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
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
