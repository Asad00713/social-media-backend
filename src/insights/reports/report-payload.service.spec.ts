import { ConflictException } from '@nestjs/common';
import { customWindow } from '../../post-performance/period';
import type { AudienceService } from '../audience/audience.service';
import type { InsightsOverviewDto } from '../dto/insights.dto';
import type { InsightsChannelsRepository } from '../insights-channels.repository';
import type { InsightsService } from '../insights.service';
import {
  NoChannelsLeftError,
  ReportPayloadService,
} from './report-payload.service';
import type { ReportSettings } from './reports.dto';
import type { ReportsRepository } from './reports.repository';

type Settings = Omit<ReportSettings, 'schedule'>;

const WS = '5d0b6f0e-1111-4222-8333-944455556666';
const NOW = new Date('2026-11-13T09:00:00Z');
const TZ = 'Asia/Karachi';

const CHANNELS = [
  { id: 1, platform: 'instagram', accountName: 'Acme IG' },
  { id: 2, platform: 'linkedin', accountName: 'Acme LinkedIn' },
  { id: 3, platform: 'facebook', accountName: 'Acme FB' },
  { id: 4, platform: 'instagram', accountName: 'Acme IG 2' },
];

/** A full overview: it carries series, channels and standout on purpose. */
function overviewFixture(channelIds: number[]): InsightsOverviewDto {
  return {
    days: 30,
    window: {
      from: '2026-10-14',
      to: '2026-11-12',
      previousFrom: '2026-09-14',
      previousTo: '2026-10-13',
      compareFrom: null,
      compareTo: null,
    },
    compare: 'usual',
    timezone: TZ,
    channelIds,
    stillCollectingFrom: '2026-11-10',
    firstRun: false,
    freshness: channelIds.map((channelId) => ({
      channelId,
      lastSyncedAt: null,
      failing: false,
      isActive: true,
      connectionStatus: 'connected',
      backfill: 'complete',
      reportsViews: true,
      reportsReach: false,
      reportsFollowers: true,
    })),
    kpis: { followers: { value: 10 } },
    series: [{ date: '2026-11-01' }],
    comparisonSeries: null,
    usual: null,
    previousSeries: [],
    channels: [{ channelId: 3, name: 'Acme FB' }],
    lane: [{ postId: 'p1' }],
    top: { impressions: [], engagements: [], comments: [] },
    formats: [],
    unknownFormatPosts: 0,
    bestTimes: {},
    standout: { up: [{ postId: 'p1' }] },
    brief: { sentences: [] },
  } as unknown as InsightsOverviewDto;
}

const SIGNALS = {
  timezone: TZ,
  measuredPosts: 4,
  minPosts: 10,
  bestTimes: {
    slots: 8,
    engagement: {},
    reach: { available: false },
    usedNightSlots: false,
    useSlot: { weekday: 2, slot: 3, date: '2026-11-17' },
  },
  whatWorks: { format: [], topic: { bars: [], untaggedPosts: 0 } },
  nextSteps: [{ id: 'n1', title: 'hidden from the report' }],
};

function settings(over: Partial<Settings> = {}): Settings {
  return {
    name: 'October review',
    channelIds: [1],
    period: 'last_30_days',
    customFrom: null,
    customTo: null,
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['totals'],
    note: 'For the board',
    logoMediaId: null,
    ...over,
  };
}

function build(
  opts: { growthChannels?: unknown[]; audience?: unknown[] } = {},
) {
  const insights = {
    overview: jest.fn((_ws: string, _p: unknown, channels: string) =>
      Promise.resolve(
        overviewFixture(channels.split(',').map((c) => Number(c))),
      ),
    ),
    signals: jest.fn().mockResolvedValue(SIGNALS),
  };
  const audience = {
    growth: jest.fn().mockResolvedValue({
      window: { from: '2026-10-14', to: '2026-11-12' },
      total: { current: null, change: null, series: [] },
      channels: opts.growthChannels ?? [],
    }),
    channels: jest.fn().mockResolvedValue({ channels: opts.audience ?? [] }),
  };
  const channelsRepo = {
    socialChannels: jest.fn().mockResolvedValue(CHANNELS),
  };
  const reports = {
    workspaceInfo: jest.fn().mockResolvedValue({
      name: 'Acme',
      timezone: TZ,
      isActive: true,
    }),
    logoUrl: jest.fn().mockResolvedValue('https://cdn.example.test/logo.png'),
  };
  const service = new ReportPayloadService(
    insights as unknown as InsightsService,
    audience as unknown as AudienceService,
    channelsRepo as unknown as InsightsChannelsRepository,
    reports as unknown as ReportsRepository,
  );
  return { service, insights, audience, channelsRepo, reports };
}

describe('ReportPayloadService.payload', () => {
  it('a totals-only report leaks nothing past its totals (Review Focus 4)', async () => {
    const { service, insights, audience } = build();
    const p = await service.payload(WS, settings(), NOW);

    expect(Object.keys(p.overview!).sort()).toEqual([
      'channelIds',
      'compare',
      'days',
      'freshness',
      'kpis',
      'timezone',
      'usual',
      'window',
    ]);
    expect(p.signals).toBeNull();
    expect(p.audience).toBeNull();
    expect(p.overview!.channelIds).toEqual([1]);
    // Freshness is the report's own channels' metadata, no other channel's.
    expect(p.overview!.freshness!.map((f) => f.channelId)).toEqual([1]);

    const json = JSON.stringify(p);
    // The payload's own `channels` list is the report's channels; the
    // overview's per-channel breakdown must not be in it.
    expect(JSON.stringify(p.overview)).not.toContain('"channels"');
    for (const k of ['"series"', '"standout"', '"workspaceId"']) {
      expect(json).not.toContain(k);
    }
    expect(json).not.toContain(WS);
    for (const other of ['Acme LinkedIn', 'Acme FB', 'Acme IG 2']) {
      expect(json).not.toContain(other);
    }
    expect(insights.overview).toHaveBeenCalledWith(
      WS,
      expect.anything(),
      '1',
      TZ,
      'usual',
      NOW,
    );
    expect(insights.signals).not.toHaveBeenCalled();
    expect(audience.growth).not.toHaveBeenCalled();
    expect(audience.channels).not.toHaveBeenCalled();
  });

  it('lists the report channels only, in channel order, never the workspace', async () => {
    const { service } = build();
    const p = await service.payload(WS, settings({ channelIds: [3, 1] }), NOW);
    expect(p.channels).toEqual([
      { id: 3, platform: 'facebook', name: 'Acme FB' },
      { id: 1, platform: 'instagram', name: 'Acme IG' },
    ]);
    expect(p.platforms).toEqual(['facebook', 'instagram']);
  });

  it('a report on 1 of 3 channels has exactly that channel', async () => {
    const { service } = build();
    const p = await service.payload(WS, settings({ channelIds: [2] }), NOW);
    expect(p.channels).toEqual([
      { id: 2, platform: 'linkedin', name: 'Acme LinkedIn' },
    ]);
  });

  it('throws before any Insights call when every channel is gone (Review Focus 3)', async () => {
    const { service, insights, audience } = build();
    const call = service.payload(
      WS,
      settings({
        channelIds: [99],
        sections: ['totals', 'what_works', 'audience'],
      }),
      NOW,
    );
    await expect(call).rejects.toBeInstanceOf(NoChannelsLeftError);
    await expect(call).rejects.toBeInstanceOf(ConflictException);
    await expect(call).rejects.toThrow('No channels left in this report');
    expect(insights.overview).not.toHaveBeenCalled();
    expect(insights.signals).not.toHaveBeenCalled();
    expect(audience.growth).not.toHaveBeenCalled();
    expect(audience.channels).not.toHaveBeenCalled();
  });

  it('drops a deleted channel and keeps the rest', async () => {
    const { service, insights } = build();
    const p = await service.payload(WS, settings({ channelIds: [99, 3] }), NOW);
    expect(insights.overview).toHaveBeenCalledWith(
      WS,
      expect.anything(),
      '3',
      TZ,
      'usual',
      NOW,
    );
    expect(p.platforms).toEqual(['facebook']);
    expect(p.channels.map((c) => c.id)).toEqual([3]);
  });

  it('reads signals with no user, and no overview, for what_works and best_time', async () => {
    const { service, insights, audience } = build();
    const p = await service.payload(
      WS,
      settings({ sections: ['best_time', 'what_works'] }),
      NOW,
    );
    expect(insights.signals).toHaveBeenCalledWith(WS, null, '1', NOW);
    expect(insights.overview).not.toHaveBeenCalled();
    expect(audience.growth).not.toHaveBeenCalled();
    expect(p.overview).toBeNull();
    expect(p.sections).toEqual(['what_works', 'best_time']);
  });

  it('keeps what the not-enough-posts states read, and hides the schedule gaps', async () => {
    const { service } = build();
    const p = await service.payload(
      WS,
      settings({ sections: ['what_works', 'best_time'] }),
      NOW,
    );
    expect(p.signals).toMatchObject({
      timezone: TZ,
      measuredPosts: 4,
      minPosts: 10,
      whatWorks: SIGNALS.whatWorks,
    });
    expect(p.signals!.bestTimes).toMatchObject({
      slots: 8,
      usedNightSlots: false,
    });
    expect(p.signals!.bestTimes!.useSlot).toBeNull();
    expect(p.signals).not.toHaveProperty('nextSteps');
    expect(JSON.stringify(p)).not.toContain('2026-11-17');
  });

  it('sends only the signals panel that was chosen', async () => {
    const { service } = build();
    const best = await service.payload(
      WS,
      settings({ sections: ['best_time'] }),
      NOW,
    );
    expect(best.signals).not.toHaveProperty('whatWorks');
    expect(best.signals).toHaveProperty('bestTimes');
    const works = await service.payload(
      WS,
      settings({ sections: ['what_works'] }),
      NOW,
    );
    expect(works.signals).toHaveProperty('whatWorks');
    expect(works.signals).not.toHaveProperty('bestTimes');
  });

  it('drops audience when no channel has anything to show, and keeps the block', async () => {
    const { service } = build({
      audience: [{ channelId: 1, status: 'unsupported' }],
    });
    const p = await service.payload(
      WS,
      settings({ sections: ['audience'] }),
      NOW,
    );
    expect(p.sections).toEqual([]);
    expect(p.audience).not.toBeNull();
  });

  it('keeps audience when a channel has an ok status', async () => {
    const { service, audience } = build({
      audience: [
        { channelId: 1, status: 'unsupported' },
        { channelId: 2, status: 'ok' },
      ],
    });
    const p = await service.payload(
      WS,
      settings({ channelIds: [1, 2], sections: ['audience'] }),
      NOW,
    );
    expect(p.sections).toEqual(['audience']);
    expect(audience.growth).toHaveBeenCalledWith(WS, expect.anything(), '1,2');
    expect(audience.channels).toHaveBeenCalledWith(
      WS,
      expect.anything(),
      '1,2',
      NOW,
    );
  });

  it('keeps audience when growth has channels', async () => {
    const { service } = build({ growthChannels: [{ channelId: 1 }] });
    const p = await service.payload(
      WS,
      settings({ sections: ['audience'] }),
      NOW,
    );
    expect(p.sections).toEqual(['audience']);
  });

  it('puts the chosen sections in canonical order whatever the input order', async () => {
    const { service } = build();
    const p = await service.payload(
      WS,
      settings({ sections: ['how_we_count', 'brief', 'totals'] }),
      NOW,
    );
    expect(p.sections).toEqual(['brief', 'totals', 'how_we_count']);
  });

  it('builds the last quarter in the workspace zone, 92 days', async () => {
    const { service, insights } = build();
    const at = new Date('2026-10-01T09:00:00Z');
    await service.payload(WS, settings({ period: 'last_quarter' }), at);
    expect(insights.overview).toHaveBeenCalledWith(
      WS,
      { days: 92, window: customWindow('2026-07-01', '2026-09-30') },
      '1',
      TZ,
      'usual',
      at,
    );
  });

  it('de-duplicates the platforms', async () => {
    const { service } = build();
    const p = await service.payload(
      WS,
      settings({ channelIds: [1, 4, 2] }),
      NOW,
    );
    expect(p.platforms).toEqual(['instagram', 'linkedin']);
  });

  it('resolves the chart metric against the overview freshness', async () => {
    const { service } = build();
    // The fixture reports views but not reach.
    const p = await service.payload(
      WS,
      settings({ chartMetric: 'reach', sections: ['main_chart'] }),
      NOW,
    );
    expect(p.chartMetric).toBe('views');
  });

  it('keeps the wanted metric when no overview was read', async () => {
    const { service } = build();
    const p = await service.payload(
      WS,
      settings({ chartMetric: 'reach', sections: ['what_works'] }),
      NOW,
    );
    expect(p.chartMetric).toBe('reach');
  });

  it('carries the header facts from the settings and the workspace', async () => {
    const { service, reports } = build();
    const p = await service.payload(
      WS,
      settings({ logoMediaId: 'm1', compare: 'none' }),
      NOW,
    );
    expect(reports.logoUrl).toHaveBeenCalledWith(WS, 'm1');
    expect(p).toMatchObject({
      name: 'October review',
      note: 'For the board',
      logoUrl: 'https://cdn.example.test/logo.png',
      compare: 'none',
      timezone: TZ,
      generatedAt: NOW.toISOString(),
      window: { from: '2026-10-14', to: '2026-11-12' },
    });
  });
});
