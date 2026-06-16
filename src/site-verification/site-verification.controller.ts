import { Controller, Get, Header } from '@nestjs/common';

/**
 * Serves platform domain-ownership verification files at the domain root.
 *
 * These are public, well-known files that third-party platforms fetch to
 * confirm we control this domain. They must be served verbatim as
 * `text/plain` at a fixed root path (no global prefix, no auth, no redirect).
 *
 * TikTok (URL-prefix / signature-file method):
 *   The TikTok for Developers portal issues a file named
 *   `tiktok<token>.txt` whose body is `tiktok-developers-site-verification=<token>`.
 *   It must resolve at `https://<domain>/tiktok<token>.txt`.
 *   Docs: TikTok for Developers → URL properties → "Verify with a file".
 *
 * The verification token is not a secret (the file is publicly served), but it
 * is overridable via env so it can be rotated without a code change.
 */
@Controller()
export class SiteVerificationController {
  private static readonly TIKTOK_VERIFICATION =
    process.env.TIKTOK_SITE_VERIFICATION ??
    'tiktok-developers-site-verification=BWGOXBTMJ4RXb76i56qZc99OfEZIAzIi';

  @Get('tiktokBWGOXBTMJ4RXb76i56qZc99OfEZIAzIi.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  getTikTokVerification(): string {
    return SiteVerificationController.TIKTOK_VERIFICATION;
  }
}
