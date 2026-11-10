import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { REDIRECT_PATH } from './short-link-rules';
import { ShortLinksService } from './short-links.service';

/** What an unknown, malformed or unsafe code answers. */
export const NOT_FOUND_TEXT = 'This short link does not exist.';

/**
 * The public redirect, `GET /l/:code`. No auth guard: whoever clicks a link
 * in a published post has no Schedura account. The global suspension guard
 * passes it (no workspace id in the path), and the app has no global prefix.
 *
 * 302, not 301: a permanent redirect is cached by browsers and would stop
 * every later click from reaching us to be counted. `no-store` for the same
 * reason, and `noindex` so search engines index the target, not the link.
 */
@Controller(REDIRECT_PATH)
export class ShortLinkRedirectController {
  constructor(private readonly shortLinks: ShortLinksService) {}

  @Get(':code')
  async redirect(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.shortLinks.resolve(code, req.method !== 'HEAD');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!target) {
      res.status(404).type('text/plain').send(NOT_FOUND_TEXT);
      return;
    }
    res.redirect(302, target);
  }
}
