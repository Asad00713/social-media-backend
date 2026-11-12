import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { periodOf, single } from '../lib/query';
import type { AudienceChannelsDto, AudienceGrowthDto } from './audience.dto';
import { AudienceService } from './audience.service';

/**
 * A query param as Express hands it over: a repeated one is an array. Every
 * param goes through `single` so a repeat is a 400, never a crash.
 */
type Raw = string | string[];

/** The Insights Audience tab. Same access as the rest of Insights. */
@Controller('insights/workspaces/:workspaceId/audience')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('analytics:view')
export class AudienceController {
  constructor(private readonly audience: AudienceService) {}

  /** Follower growth per channel and in total, across the window. */
  @Get('growth')
  growth(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
  ): Promise<AudienceGrowthDto> {
    return this.audience.growth(
      workspaceId,
      periodOf(days, from, to),
      single(channels, 'channels'),
    );
  }

  /** The same growth table as a CSV download. */
  @Get('growth/export')
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
  ): Promise<string> {
    const { filename, body } = await this.audience.csv(
      workspaceId,
      periodOf(days, from, to),
      single(channels, 'channels'),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** Where each channel's audience is: countries, cities, ages, genders. */
  @Get('channels')
  channels(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: Raw,
    @Query('from') from?: Raw,
    @Query('to') to?: Raw,
    @Query('channels') channels?: Raw,
  ): Promise<AudienceChannelsDto> {
    return this.audience.channels(
      workspaceId,
      periodOf(days, from, to),
      single(channels, 'channels'),
    );
  }
}
