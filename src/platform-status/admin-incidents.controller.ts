import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { StatusIncidentDto } from './dto/status-page.dto';
import {
  CreateIncidentDto,
  IncidentListQueryDto,
  UpdateIncidentDto,
} from './dto/incident.dto';
import { PlatformIncidentsService } from './platform-incidents.service';

/**
 * Incidents on the status page, posted by hand. Super admins only, like the
 * rest of /admin. The schedura-admin app's UI for these comes later.
 */
@Controller('admin/status/incidents')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminIncidentsController {
  constructor(private readonly incidents: PlatformIncidentsService) {}

  @Get()
  list(@Query() query: IncidentListQueryDto): Promise<StatusIncidentDto[]> {
    return this.incidents.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() admin: { userId: string },
    @Body() dto: CreateIncidentDto,
  ): Promise<StatusIncidentDto> {
    return this.incidents.create(admin.userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIncidentDto,
  ): Promise<StatusIncidentDto> {
    return this.incidents.update(admin.userId, id, dto);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() admin: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StatusIncidentDto> {
    return this.incidents.resolve(admin.userId, id);
  }
}
