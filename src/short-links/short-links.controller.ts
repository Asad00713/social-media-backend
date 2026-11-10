import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  CreateShortLinkDto,
  ListShortLinksQueryDto,
  type ShortLinkDto,
  type ShortLinkListDto,
} from './dto/short-links.dto';
import { ShortLinksService } from './short-links.service';

/**
 * The workspace's short links. Anyone who can draft a post may shorten a
 * link in it and see how often it was clicked.
 */
@Controller('short-links/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ShortLinksController {
  constructor(private readonly shortLinks: ShortLinksService) {}

  /** Idempotent: the same URL in the same workspace returns the same code. */
  @RequireCapability('posts:draft')
  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateShortLinkDto,
  ): Promise<ShortLinkDto> {
    return this.shortLinks.create(workspaceId, user.userId, dto);
  }

  @RequireCapability('posts:draft')
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListShortLinksQueryDto,
  ): Promise<ShortLinkListDto> {
    return this.shortLinks.list(workspaceId, query);
  }
}
