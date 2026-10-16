import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaSourcesService } from './media-sources.service';
import { BrowseSourceDto } from './dto/browse.dto';
import { ImportSourceDto } from './dto/import.dto';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';

@Controller('channels/workspaces/:workspaceId/media-sources')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class MediaSourcesController {
  constructor(private readonly service: MediaSourcesService) {}

  @Post(':channelId/browse')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  browse(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: BrowseSourceDto,
  ) {
    return this.service.browse(workspaceId, parseInt(channelId, 10), dto);
  }

  @Post(':channelId/import')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  import(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: ImportSourceDto,
  ) {
    return this.service.import(workspaceId, parseInt(channelId, 10), dto);
  }
}
