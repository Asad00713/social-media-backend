import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { StatusPageDto } from './dto/status-page.dto';
import { PlatformStatusService } from './platform-status.service';

/**
 * The in-app status page. Any signed-in user may read it: it is the same for
 * everyone and holds no workspace data (the client marks which platforms its
 * own workspace uses).
 */
@Controller('status')
@UseGuards(JwtAuthGuard)
export class PlatformStatusController {
  constructor(private readonly status: PlatformStatusService) {}

  @Get()
  get(): Promise<StatusPageDto> {
    return this.status.getStatusPage();
  }
}
