import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { CallerRole } from '../posts/guest-rules';
import { CurrentWorkspaceRole } from '../workspace-members/current-workspace-role.decorator';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { BrandKitService } from './brand-kit.service';
import { UpdateBrandKitDto, type BrandKitDto } from './dto/brand-kit.dto';

/**
 * The workspace brand kit. Anyone who can draft reads it (the photo editor
 * offers its colours, logo and presets); ADMIN and OWNER change it.
 */
@Controller('brand-kit/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class BrandKitController {
  constructor(private readonly brandKit: BrandKitService) {}

  @RequireCapability('posts:draft')
  @Get()
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentWorkspaceRole() role: CallerRole,
  ): Promise<BrandKitDto> {
    return this.brandKit.get(workspaceId, role);
  }

  @RequireCapability('brand:manage')
  @Put()
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @CurrentWorkspaceRole() role: CallerRole,
    @Body() dto: UpdateBrandKitDto,
  ): Promise<BrandKitDto> {
    return this.brandKit.update(workspaceId, user.userId, role, dto);
  }
}
