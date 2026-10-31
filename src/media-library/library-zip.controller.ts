import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { WorkspaceAccessService } from '../workspace-members/workspace-access.service';
import { CategoryZipService } from './services/category-zip.service';
import { readZipTicketSecret, verifyZipTicket } from './lib/zip-ticket';

const INVALID_TICKET = {
  code: 'INVALID_TICKET',
  message: 'This download link is invalid or has expired.',
} as const;

/**
 * The one workspace route without `WorkspaceRoleGuard` (an `OPEN_ROUTES`
 * entry): a browser navigation cannot carry the in-memory bearer token. The
 * ticket in the query string is the credential instead. It is minted by the
 * posts:draft-gated `POST …/zip-ticket`, lives 5 minutes, is bound to this
 * workspace, folder and user, and the user is re-checked for posts:draft here
 * so a member removed since minting is refused.
 */
@Controller('workspaces/:workspaceId/media-library')
export class LibraryZipController {
  constructor(
    private readonly categoryZip: CategoryZipService,
    private readonly access: WorkspaceAccessService,
  ) {}

  @Get('categories/:categoryId/zip')
  async downloadCategoryZip(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Query('ticket') ticket: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const secret = readZipTicketSecret();
    const payload =
      ticket && secret ? verifyZipTicket(ticket, secret, new Date()) : null;
    if (
      !payload ||
      payload.workspaceId !== workspaceId ||
      payload.categoryId !== categoryId
    ) {
      throw new UnauthorizedException(INVALID_TICKET);
    }

    try {
      await this.access.assertCan(workspaceId, payload.userId, 'posts:draft');
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new UnauthorizedException(INVALID_TICKET);
      }
      throw err;
    }

    await this.categoryZip.streamZip(workspaceId, categoryId, res);
  }
}
