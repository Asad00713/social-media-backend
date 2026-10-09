import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { WorkspaceHubDto } from './dto/workspace-hub.dto';
import { WorkspaceHubService } from './workspace-hub.service';

/**
 * The Workspaces hub page: where a signed-in user lands when the app can't
 * tell which workspace to open. No workspace id in the path — the service
 * reads the caller's own memberships — so no role guard is needed.
 */
@Controller('workspace-hub')
@UseGuards(JwtAuthGuard)
export class WorkspaceHubController {
  constructor(private readonly hub: WorkspaceHubService) {}

  /** A card for each workspace the caller owns or joined. */
  @Get()
  list(@CurrentUser() user: { userId: string }): Promise<WorkspaceHubDto> {
    return this.hub.listSummaries(user.userId);
  }
}
