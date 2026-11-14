import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AudienceService } from '../audience/audience.service';
import { InsightsService } from '../insights.service';
import { InsightsChannelsRepository } from '../insights-channels.repository';
import { resolveReportPeriod } from './lib/report-period';
import {
  pickOverview,
  resolveChartMetric,
  SECTION_FIELDS,
} from './lib/section-fields';
import {
  REPORT_SECTIONS,
  type ReportPayloadDto,
  type ReportSection,
  type ReportSettings,
} from './reports.dto';
import { ReportsRepository } from './reports.repository';

/** Every channel a report named has been deleted. */
export class NoChannelsLeftError extends ConflictException {
  constructor() {
    super('No channels left in this report');
  }
}

/**
 * The numbers a report shows, from the existing Insights and Audience
 * services, for only the chosen sections. The public link, the PDF and the
 * preview all read this, so what it leaves out is what a client never sees.
 */
@Injectable()
export class ReportPayloadService {
  constructor(
    private readonly insights: InsightsService,
    private readonly audience: AudienceService,
    private readonly channelsRepo: InsightsChannelsRepository,
    private readonly reports: ReportsRepository,
  ) {}

  async payload(
    workspaceId: string,
    settings: Omit<ReportSettings, 'schedule'>,
    now = new Date(),
  ): Promise<ReportPayloadDto> {
    const [social, info] = await Promise.all([
      this.channelsRepo.socialChannels(workspaceId),
      this.reports.workspaceInfo(workspaceId),
    ]);
    if (!info) throw new NotFoundException('Workspace not found');
    const byId = new Map(social.map((c) => [c.id, c]));
    const kept = settings.channelIds.flatMap((id) => byId.get(id) ?? []);
    // Before any Insights call: an empty `channels` param means every channel.
    if (!kept.length) throw new NoChannelsLeftError();

    const tz = info.timezone;
    const period = resolveReportPeriod(settings, tz, now);
    const channels = kept.map((c) => c.id).join(',');
    const chosen = REPORT_SECTIONS.filter((s) => settings.sections.includes(s));
    const has = (s: ReportSection) => chosen.includes(s);
    const wantsOverview = chosen.some((s) => s in SECTION_FIELDS);
    const wantsSignals = has('what_works') || has('best_time');

    const [overview, signals, growth, audienceChannels, logoUrl] =
      await Promise.all([
        wantsOverview
          ? this.insights.overview(
              workspaceId,
              period,
              channels,
              tz,
              settings.compare,
              now,
            )
          : null,
        wantsSignals
          ? this.insights.signals(workspaceId, null, channels, now)
          : null,
        has('audience')
          ? this.audience.growth(workspaceId, period, channels)
          : null,
        has('audience')
          ? this.audience.channels(workspaceId, period, channels, now)
          : null,
        this.reports.logoUrl(workspaceId, settings.logoMediaId),
      ]);

    const audience =
      growth && audienceChannels
        ? { growth, channels: audienceChannels }
        : null;
    const audienceIsEmpty =
      !!audience &&
      !audience.growth.channels.length &&
      !audience.channels.channels.some((c) => c.status === 'ok');

    return {
      name: settings.name,
      logoUrl,
      note: settings.note,
      window: { from: period.window.from, to: period.window.to },
      timezone: tz,
      platforms: [...new Set(kept.map((c) => c.platform))],
      channels: kept.map((c) => ({
        id: c.id,
        platform: c.platform,
        name: c.accountName,
      })),
      compare: settings.compare,
      chartMetric: overview
        ? resolveChartMetric(settings.chartMetric, overview.freshness)
        : settings.chartMetric,
      sections: audienceIsEmpty
        ? chosen.filter((s) => s !== 'audience')
        : chosen,
      generatedAt: now.toISOString(),
      overview: overview ? pickOverview(overview, chosen) : null,
      signals: signals
        ? {
            timezone: signals.timezone,
            measuredPosts: signals.measuredPosts,
            minPosts: signals.minPosts,
            ...(has('what_works') && { whatWorks: signals.whatWorks }),
            // An in-app action that reveals schedule gaps: never in a report.
            ...(has('best_time') && {
              bestTimes: { ...signals.bestTimes, useSlot: null },
            }),
          }
        : null,
      audience,
    };
  }
}
