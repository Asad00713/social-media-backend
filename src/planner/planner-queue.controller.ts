import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import {
  QueueSlotsService,
  type QueueDto,
} from './services/queue-slots.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHANNELS = 50;

/**
 * The next free and the top slot of the caller's posting queue — the
 * composer's When menu reads it. `channelIds` is a comma-separated list of
 * the draft's channel ids; `excludePostId` is the draft's own id.
 */
@Controller('planner/workspaces/:workspaceId/queue')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlannerQueueController {
  constructor(private readonly queue: QueueSlotsService) {}

  @RequireCapability('posts:draft')
  @Get()
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Query('channelIds') channelIdsRaw?: string,
    @Query('excludePostId') excludePostId?: string,
  ): Promise<QueueDto> {
    const channelIds = (channelIdsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (
      channelIds.length > MAX_CHANNELS ||
      channelIds.some((id) => !/^\d+$/.test(id))
    ) {
      throw new BadRequestException('channelIds must be numeric channel ids');
    }
    if (excludePostId !== undefined && !UUID_RE.test(excludePostId)) {
      throw new BadRequestException('excludePostId must be a UUID');
    }
    return await this.queue.get(workspaceId, user.userId, {
      channelIds,
      excludePostId,
    });
  }
}
