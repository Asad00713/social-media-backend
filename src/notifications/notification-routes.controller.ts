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

@Controller('notifications/workspaces/:workspaceId/routes')
@UseGuards(JwtAuthGuard)
export class NotificationRoutesController {
  constructor(private readonly routes: NotificationRoutesService) {}

  @Get()
  list(@Param('workspaceId') wid: string) {
    return this.routes.list(wid);
  }

  @Post()
  create(
    @Param('workspaceId') wid: string,
    @Body() body: CreateNotificationRouteDto,
  ) {
    return this.routes.create(wid, body);
  }

  @Patch(':id')
  update(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @Body() body: UpdateNotificationRouteDto,
  ) {
    return this.routes.update(wid, id, body);
  }

  @Delete(':id')
  delete(@Param('workspaceId') wid: string, @Param('id') id: string) {
    return this.routes.delete(wid, id);
  }
}
