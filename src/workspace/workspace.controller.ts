import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { SkipLaunchGate } from 'src/auth/decorators/skip-launch-gate.decorator';
import { RequireCapability } from 'src/workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from 'src/workspace-members/workspace-role.guard';
import { CloudflareR2Service } from 'src/media/cloudflare-r2.service';
import { PresignLogoDto } from './dto/presign-logo.dto';
import { DeleteWorkspaceDto } from './dto/delete-workspace.dto';

@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly r2: CloudflareR2Service,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  // Pre-launch setup route: a non-allowlisted user creates their workspace
  // during onboarding even though the launch gate blocks the rest of the app.
  @SkipLaunchGate()
  async create(
    @Body() dto: CreateWorkspaceDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.workspaceService.create(dto, user.userId);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(
    @CurrentUser() user: { userId: string; email: string },
    @Query('page', new ParseIntPipe({ optional: true })) page: number = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit: number = 10,
    @Query('search') search?: string,
    @Query('isActive', new ParseBoolPipe({ optional: true }))
    isActive?: boolean,
  ) {
    const result = await this.workspaceService.findAllPaginated(
      user.userId,
      page,
      limit,
      search,
      isActive,
    );

    return {
      success: true,
      ...result,
    };
  }

  // Declared before the `:workspaceId/...` GETs: a workspace whose slug is
  // literally `publishing-defaults` must still resolve here.
  @Get('slug/:slug')
  @UseGuards(JwtAuthGuard)
  async findBySlug(
    @Param('slug') slug: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const workspace = await this.workspaceService.findOne(
      slug,
      user.userId,
      true,
    );

    return {
      success: true,
      data: workspace,
    };
  }

  // Any member may read General (`settings:view`); the guard resolves the
  // workspace from :workspaceId, which is why this param is not called :id.
  @Get(':workspaceId')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('settings:view')
  async findOne(@Param('workspaceId') workspaceId: string) {
    return {
      success: true,
      data: await this.workspaceService.findDetail(workspaceId),
    };
  }

  /** The composer's starting switches: anyone who can draft needs them. */
  @Get(':workspaceId/publishing-defaults')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('posts:draft')
  async publishingDefaults(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.getPublishingDefaults(workspaceId);
  }

  @Patch(':workspaceId')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('workspace:manage')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body() updateWorkspaceDto: UpdateWorkspaceDto,
  ) {
    const { timezoneMove } = await this.workspaceService.update(
      workspaceId,
      updateWorkspaceDto,
    );

    return {
      success: true,
      message: 'Workspace updated successfully',
      // The detail, not the raw row: the row carries the encrypted Maestro
      // key and the join-link code, and an ADMIN now receives this response.
      data: await this.workspaceService.findDetail(workspaceId),
      timezoneMove,
    };
  }

  /**
   * A presigned URL to upload the workspace logo to. The browser PUTs the
   * file straight to R2, then PATCHes the returned `publicUrl` back as `logo`.
   */
  @Post(':workspaceId/logo/presign')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('workspace:manage')
  @HttpCode(HttpStatus.OK)
  presignLogo(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PresignLogoDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.r2.createPresignedUpload({
      workspaceId,
      userId: user.userId,
      kind: 'workspace-logo',
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filename: dto.filename,
    });
  }

  /** What a delete would take with it, for the typed-confirm dialog. */
  @Get(':workspaceId/deletion-preview')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('workspace:delete')
  deletionPreview(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.deletionPreview(workspaceId);
  }

  // `workspace:delete` is OWNER-only (a platform super admin passes the
  // guard too): the guard is the authorisation, the typed name the confirm.
  @Delete(':workspaceId/permanent')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('workspace:delete')
  @HttpCode(HttpStatus.OK)
  async removePermanently(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: DeleteWorkspaceDto,
  ) {
    const result = await this.workspaceService.remove(
      workspaceId,
      user.userId,
      dto.confirmName,
    );

    return {
      success: true,
      ...result,
    };
  }
}
