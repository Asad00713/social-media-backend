import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

@Controller('workspaces/:workspaceId/whatsapp-templates')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class WhatsAppTemplatesController {
  constructor(private readonly service: WhatsAppTemplatesService) {}

  @Get()
  @RequireCapability('inbox:view')
  async list(@Param('workspaceId') workspaceId: string) {
    return this.service.listForWorkspace(workspaceId);
  }

  @Post('sync')
  @RequireCapability('inbox:view')
  @HttpCode(HttpStatus.OK)
  async sync(@Param('workspaceId') workspaceId: string) {
    // Explicit user action — bypass the per-channel throttle.
    return this.service.syncWorkspace(workspaceId, { force: true });
  }

  @Delete(':id')
  @RequireCapability('channels:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    await this.service.deleteTemplate(workspaceId, id);
  }
}
