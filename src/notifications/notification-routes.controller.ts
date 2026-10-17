import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationRoutesService } from './notification-routes.service';
import {
  CreateNotificationRouteDto,
  UpdateNotificationRouteDto,
} from './dto/notification-route.dto';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';

@Controller('notifications/workspaces/:workspaceId/routes')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class NotificationRoutesController {
  constructor(private readonly routes: NotificationRoutesService) {}

  @Get()
  @RequireCapability('team:view')
  list(@Param('workspaceId') wid: string) {
    return this.routes.list(wid);
  }

  @Post()
  @RequireCapability('channels:manage')
  create(
    @Param('workspaceId') wid: string,
    @Body() body: CreateNotificationRouteDto,
  ) {
    return this.routes.create(wid, body);
  }

  @Patch(':id')
  @RequireCapability('channels:manage')
  update(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @Body() body: UpdateNotificationRouteDto,
  ) {
    return this.routes.update(wid, id, body);
  }

  @Delete(':id')
  @RequireCapability('channels:manage')
  delete(@Param('workspaceId') wid: string, @Param('id') id: string) {
    return this.routes.delete(wid, id);
  }
}
