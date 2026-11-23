import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import type { BrandVoice } from './brand-voice.types';
import { BrandVoiceService } from './brand-voice.service';
import {
  RevertBrandVoiceDto,
  UpdateBrandVoiceDto,
} from './dto/brand-voice.dto';

/**
 * The workspace brand voice. Members read it (Settings); ADMIN and OWNER
 * change it or undo the last change. A save names the version it read, so a
 * stale editor gets a 409 instead of overwriting someone else's change.
 */
@Controller('workspaces/:workspaceId/brand-voice')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class BrandVoiceController {
  constructor(private readonly brandVoice: BrandVoiceService) {}

  @RequireCapability('settings:view')
  @Get()
  get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<BrandVoice> {
    return this.brandVoice.get(workspaceId);
  }

  @RequireCapability('brand:manage')
  @Patch()
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: UpdateBrandVoiceDto,
  ): Promise<BrandVoice> {
    return this.brandVoice.update(workspaceId, dto);
  }

  @RequireCapability('brand:manage')
  @Post('revert')
  @HttpCode(200)
  revert(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: RevertBrandVoiceDto,
  ): Promise<BrandVoice> {
    return this.brandVoice.revert(workspaceId, dto.version);
  }
}
