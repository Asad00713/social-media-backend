import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { ComposerAssistService } from './composer-assist.service';
import {
  ComposerFillBlanksDto,
  ComposerFinishDto,
  ComposerFitChannelsDto,
  ComposerLinkDto,
} from './dto/composer-assist.dto';

/**
 * The composer's Maestro actions: Finish my draft, Fit every channel, Turn a
 * link into a post, Fill the blanks. Same guards and capability as the other
 * drafting routes in AiController; metered per action.
 */
@Controller('ai/workspaces/:workspaceId/composer')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ComposerAssistController {
  constructor(private readonly assist: ComposerAssistService) {}

  @Post('finish')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  finish(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ComposerFinishDto,
  ) {
    return this.assist.finishDraft(workspaceId, user.userId, dto);
  }

  @Post('fit-channels')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  fitChannels(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ComposerFitChannelsDto,
  ) {
    return this.assist.fitChannels(workspaceId, user.userId, dto);
  }

  @Post('from-link')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  fromLink(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ComposerLinkDto,
  ) {
    return this.assist.postFromLink(workspaceId, user.userId, dto);
  }

  @Post('fill-blanks')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  fillBlanks(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ComposerFillBlanksDto,
  ) {
    return this.assist.fillBlanks(workspaceId, user.userId, dto);
  }
}
