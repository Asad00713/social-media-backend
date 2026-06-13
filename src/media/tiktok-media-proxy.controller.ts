import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TikTokMediaProxyService } from './tiktok-media-proxy.service';

/**
 * TikTok Media Proxy Controller
 *
 * Public endpoint used as the URL handed to TikTok during PULL_FROM_URL
 * publish flows. TikTok requires the URL to live on the dev-console-verified
 * domain (`api.schedura.ai`). This route validates the signed token, then
 * streams the upstream Cloudinary/R2 bytes through unchanged.
 *
 * No auth guard — TikTok's fetcher cannot present credentials. Security comes
 * from the short-lived signed JWT token in the path (1 hour TTL).
 *
 * Compliance: streams bytes unmodified. No watermarking, no overlay, no
 * branding injection. TikTok prohibits all of those.
 */
@Controller('api/tiktok-media')
export class TikTokMediaProxyController {
  private readonly logger = new Logger(TikTokMediaProxyController.name);

  constructor(private readonly proxy: TikTokMediaProxyService) {}

  @Get(':token')
  async stream(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    let originalUrl: string;
    try {
      originalUrl = this.proxy.verifyProxyToken(token);
    } catch (err) {
      this.logger.warn(
        `Rejected TikTok media proxy request — invalid token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(403).send('Invalid or expired token');
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(originalUrl);
    } catch (err) {
      this.logger.error(
        `Upstream fetch threw for ${originalUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(502).send('Upstream fetch failed');
      return;
    }

    if (!upstream.ok || !upstream.body) {
      this.logger.error(
        `Upstream fetch returned non-ok status ${upstream.status} for ${originalUrl}`,
      );
      res.status(502).send('Upstream fetch failed');
      return;
    }

    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'application/octet-stream',
    );
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch (err) {
      this.logger.error(
        `Streaming error for ${originalUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      res.end();
    }
  }
}
