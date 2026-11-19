import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../../auth/guards/super-admin.guard';
import { SkipSuspendCheck } from '../../auth/decorators/skip-suspend-check.decorator';
import { RequestRateService } from './request-rate.service';

/**
 * Reads the request-rate counters. Super-admin only, and read-only.
 *
 * This is the report that decides a global rate limit. It exists so the number
 * comes from this platform's own traffic rather than from a guess —
 * `app.module.ts` leaves the global throttler guard off precisely because the
 * platform "has not been measured for it", and this is the measurement.
 *
 * What to read off it: `workspaces.p99` is the busiest minute a real customer
 * has, so a limit comfortably above it refuses attackers and nobody else.
 * `busiestRoutes` says whether one endpoint needs its own ceiling instead.
 */
@Controller('admin/metrics')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@SkipSuspendCheck()
export class RequestRateController {
  constructor(private readonly rate: RequestRateService) {}

  @Get('request-rate')
  async requestRate(@Query('routes') routes?: string) {
    const limit = Math.min(100, Math.max(1, Number(routes) || 20));

    const [workspaces, perRoute, busiestRoutes] = await Promise.all([
      this.rate.workspaceSnapshot(),
      this.rate.routeSnapshot(),
      this.rate.busiestRoutes(limit),
    ]);

    return {
      // Stated in the payload so whoever reads this cannot mistake it for a
      // limit that is already in force.
      enforcing: false,
      note: 'Counting only. No request is refused by these counters.',
      unit: 'requests per minute',
      workspaces,
      routes: perRoute,
      busiestRoutes,
    };
  }
}
