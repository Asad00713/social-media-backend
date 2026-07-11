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

@Controller('channels/workspaces/:workspaceId/media-sources')
@UseGuards(JwtAuthGuard)
export class MediaSourcesController {
  constructor(private readonly service: MediaSourcesService) {}

  @Post(':channelId/browse')
  @HttpCode(HttpStatus.OK)
  browse(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: BrowseSourceDto,
  ) {
    return this.service.browse(workspaceId, parseInt(channelId, 10), dto);
  }

  @Post(':channelId/import')
  @HttpCode(HttpStatus.OK)
  import(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: ImportSourceDto,
  ) {
    return this.service.import(workspaceId, parseInt(channelId, 10), dto);
  }
}
