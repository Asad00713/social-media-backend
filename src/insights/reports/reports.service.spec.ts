import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  InsightReportRow,
  NewInsightReportRow,
} from '../../drizzle/schema/insight-reports.schema';
import type { InsightsChannelsRepository } from '../insights-channels.repository';
import type {
  CreateReportDto,
  UpdateReportDto,
} from './dto/report-settings.dto';
import type { ReportPayloadService } from './report-payload.service';
import type { ReportPayloadDto } from './reports.dto';
import type { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

const WS = '5d0b6f0e-1111-4222-8333-944455556666';
const USER = 'user-1';
const OTHER_USER = 'user-2';
const NOW = new Date('2026-11-13T00:00:00Z');
const LOGO = '7a1b2c3d-1111-4222-8333-944455556666';

const SOCIAL = [1, 2, 3].map((id) => ({
  id,
  platform: 'instagram',
  accountName: `Acme ${id}`,
}));

function createDto(over: Partial<CreateReportDto> = {}): CreateReportDto {
  return {
    name: 'Monthly review',
    channelIds: [1],
    period: 'last_30_days',
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['totals', 'brief'],
    ...over,
  } as CreateReportDto;
}

const WEEKLY = {
  cadence: 'weekly' as const,
  weekday: 1,
  sendMinute: 540,
  sendToTeam: false,
  recipients: ['client@acme.com'],
  attachPdf: true,
};

/** An in-memory ReportsRepository: what is stored is what the next read sees. */
function setup(
  opts: {
    logo?: { type: string; mimeType: string | null; isDeleted: boolean } | null;
    teamSize?: number;
  } = {},
) {
  const rows = new Map<string, InsightReportRow>();
  let seq = 0;
  const logo =
    opts.logo === undefined
      ? { type: 'image', mimeType: 'image/png', isDeleted: false }
      : opts.logo;
  const live = (row: InsightReportRow) => ({
    row,
    logoUrl: null,
    createdBy: null,
    updatedBy: null,
  });
  const repo = {
    rows,
    insert: jest.fn((v: NewInsightReportRow) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      rows.set(id, {
        id,
        optedOut: [],
        shareToken: null,
        lastSentAt: null,
        lastError: null,
        ...v,
      } as InsightReportRow);
      return Promise.resolve(id);
    }),
    update: jest.fn(
      (_ws: string, id: string, patch: Partial<NewInsightReportRow>) => {
        const cur = rows.get(id);
        if (cur) rows.set(id, { ...cur, ...patch } as InsightReportRow);
        return Promise.resolve(!!cur);
      },
    ),
    get: jest.fn((_ws: string, id: string) => {
      const row = rows.get(id);
      return Promise.resolve(row ? live(row) : null);
    }),
    list: jest.fn(() => Promise.resolve([...rows.values()].map(live))),
    remove: jest.fn((_ws: string, id: string) =>
      Promise.resolve(rows.delete(id)),
    ),
    team: jest.fn(() =>
      Promise.resolve(
        Array.from({ length: opts.teamSize ?? 3 }, (_, i) => ({
          userId: `u${i}`,
          email: `u${i}@acme.com`,
          isOwner: i === 0,
        })),
      ),
    ),
    workspaceInfo: jest.fn(() =>
      Promise.resolve({
        name: 'Acme',
        timezone: 'Asia/Karachi',
        isActive: true,
      }),
    ),
    logoItem: jest.fn(() => Promise.resolve(logo)),
  };
  const channelsRepo = {
    socialChannels: jest.fn(() => Promise.resolve(SOCIAL)),
  };
  const payloads = {
    payload: jest.fn(() => Promise.resolve({ name: 'x' } as ReportPayloadDto)),
  };
  const config = {
    get: jest.fn(() => 'https://app.schedura.ai/'),
  };
  const service = new ReportsService(
    repo as unknown as ReportsRepository,
    channelsRepo as unknown as InsightsChannelsRepository,
    payloads as unknown as ReportPayloadService,
    config as unknown as ConfigService,
  );
  const only = () => [...rows.values()][0];
  return { service, repo, channelsRepo, payloads, rows, only };
}

async function rejection(p: Promise<unknown>): Promise<BadRequestException> {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('expected a rejection');
}

describe('ReportsService.create', () => {
  it('stores only this workspace social channel ids', async () => {
    const { service, only } = setup();
    await service.create(WS, USER, createDto({ channelIds: [1, 77] }), NOW);
    expect(only().channelIds).toEqual([1]);
  });

  it('refuses a report whose channels are all someone elses', async () => {
    const { service, repo } = setup();
    const err = await rejection(
      service.create(WS, USER, createDto({ channelIds: [77] }), NOW),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Pick at least one channel');
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('refuses an SVG logo, and a logo that is not in the Library', async () => {
    const svg = setup({
      logo: { type: 'image', mimeType: 'image/svg+xml', isDeleted: false },
    });
    expect(
      (
        await rejection(
          svg.service.create(WS, USER, createDto({ logoMediaId: LOGO }), NOW),
        )
      ).message,
    ).toBe('A report logo has to be a PNG or JPG');

    const video = setup({
      logo: { type: 'video', mimeType: 'image/png', isDeleted: false },
    });
    expect(
      (
        await rejection(
          video.service.create(WS, USER, createDto({ logoMediaId: LOGO }), NOW),
        )
      ).message,
    ).toBe('A report logo has to be a PNG or JPG');

    const binned = setup({
      logo: { type: 'image', mimeType: 'image/png', isDeleted: true },
    });
    expect(
      (
        await rejection(
          binned.service.create(
            WS,
            USER,
            createDto({ logoMediaId: LOGO }),
            NOW,
          ),
        )
      ).message,
    ).toBe('That logo is not in this workspace Library');

    const missing = setup({ logo: null });
    expect(
      (
        await rejection(
          missing.service.create(
            WS,
            USER,
            createDto({ logoMediaId: LOGO }),
            NOW,
          ),
        )
      ).message,
    ).toBe('That logo is not in this workspace Library');
  });

  it('keeps a PNG logo', async () => {
    const { service, only } = setup();
    await service.create(WS, USER, createDto({ logoMediaId: LOGO }), NOW);
    expect(only().logoMediaId).toBe(LOGO);
  });

  it('stores weekly Monday 09:00 in Karachi as the next Monday 04:00Z', async () => {
    const { service, only } = setup();
    await service.create(WS, USER, createDto({ schedule: WEEKLY }), NOW);
    expect(only().nextRunAt?.toISOString()).toBe('2026-11-16T04:00:00.000Z');
    expect(only()).toMatchObject({
      cadence: 'weekly',
      weekday: 1,
      sendMinute: 540,
    });
  });

  it('stores no slot for an unscheduled report', async () => {
    const { service, only } = setup();
    await service.create(WS, USER, createDto(), NOW);
    expect(only()).toMatchObject({
      cadence: null,
      weekday: null,
      sendMinute: null,
      nextRunAt: null,
      recipients: [],
    });
  });

  it('stamps the maker and the time, and stores the sections in canonical order', async () => {
    const { service, only } = setup();
    const dto = await service.create(WS, USER, createDto(), NOW);
    expect(only()).toMatchObject({
      createdBy: USER,
      updatedBy: USER,
      updatedAt: NOW,
      sections: ['brief', 'totals'],
    });
    expect(dto.sections).toEqual(['brief', 'totals']);
  });

  it('answers 400 "<field> is required" for a missing core field', async () => {
    const { service } = setup();
    const err = await rejection(
      service.create(
        WS,
        USER,
        createDto({ name: undefined } as Partial<CreateReportDto>),
        NOW,
      ),
    );
    expect(err.message).toBe('name is required');
  });
});

describe('ReportsService.update', () => {
  async function saved(over: Partial<CreateReportDto> = {}) {
    const ctx = setup();
    await ctx.service.create(WS, USER, createDto(over), NOW);
    return { ...ctx, id: [...ctx.rows.keys()][0] };
  }
  const LATER = new Date('2026-11-14T00:00:00Z');

  it('a PATCH of the note alone leaves the slot, the channels and the schedule', async () => {
    const { service, only, id } = await saved({ schedule: WEEKLY });
    const before = { ...only() };
    await service.update(WS, OTHER_USER, id, { note: 'Hi' }, LATER);
    expect(only()).toMatchObject({
      note: 'Hi',
      nextRunAt: before.nextRunAt,
      channelIds: before.channelIds,
      cadence: 'weekly',
      recipients: ['client@acme.com'],
      updatedBy: OTHER_USER,
      updatedAt: LATER,
      createdBy: USER,
    });
  });

  it('a PATCH with schedule: null clears the schedule and the slot', async () => {
    const { service, only, id } = await saved({ schedule: WEEKLY });
    const dto = await service.update(WS, USER, id, { schedule: null }, LATER);
    expect(only()).toMatchObject({
      cadence: null,
      weekday: null,
      sendMinute: null,
      nextRunAt: null,
    });
    expect(dto.schedule).toBeNull();
  });

  it('a PATCH with a schedule recomputes the slot', async () => {
    const { service, only, id } = await saved();
    await service.update(
      WS,
      USER,
      id,
      { schedule: { ...WEEKLY, weekday: 3 } } as UpdateReportDto,
      NOW,
    );
    expect(only().nextRunAt?.toISOString()).toBe('2026-11-18T04:00:00.000Z');
  });

  it('refuses to re-add an address that opted out', async () => {
    const { service, rows, id } = await saved({ schedule: WEEKLY });
    rows.set(id, {
      ...rows.get(id)!,
      recipients: [],
      optedOut: ['gone@acme.com'],
    });
    const err = await rejection(
      service.update(
        WS,
        USER,
        id,
        {
          schedule: { ...WEEKLY, recipients: ['Gone@Acme.com'] },
        } as UpdateReportDto,
        LATER,
      ),
    );
    expect(err.message).toBe('gone@acme.com opted out of this report');
  });

  it('lets an opted-out address that is still listed stay, and lets a manager remove it', async () => {
    const { service, rows, only, id } = await saved({ schedule: WEEKLY });
    rows.set(id, {
      ...rows.get(id)!,
      recipients: ['client@acme.com', 'gone@acme.com'],
      optedOut: ['gone@acme.com'],
    });
    await service.update(WS, USER, id, { note: 'still fine' }, LATER);
    expect(only().recipients).toEqual(['client@acme.com', 'gone@acme.com']);

    await service.update(
      WS,
      USER,
      id,
      {
        schedule: { ...WEEKLY, recipients: ['client@acme.com'] },
      } as UpdateReportDto,
      LATER,
    );
    expect(only().recipients).toEqual(['client@acme.com']);
  });

  it('refuses an explicit null on a field that cannot be empty', async () => {
    const { service, repo, id } = await saved();
    for (const field of [
      'name',
      'channelIds',
      'period',
      'compare',
      'chartMetric',
      'sections',
    ]) {
      const err = await rejection(
        service.update(WS, USER, id, { [field]: null } as UpdateReportDto),
      );
      expect(err.message).toBe(`${field} cannot be empty`);
    }
    for (const field of ['sendToTeam', 'attachPdf']) {
      const err = await rejection(
        service.update(WS, USER, id, {
          schedule: { ...WEEKLY, [field]: null },
        } as unknown as UpdateReportDto),
      );
      expect(err.message).toBe(`${field} cannot be empty`);
    }
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lets null clear the note, the logo and the custom dates', async () => {
    const { service, only, id } = await saved({
      note: 'x',
      logoMediaId: LOGO,
    });
    await service.update(
      WS,
      USER,
      id,
      { note: null, logoMediaId: null },
      LATER,
    );
    expect(only()).toMatchObject({ note: null, logoMediaId: null });
  });

  it('answers 404 for a report of another workspace', async () => {
    const { service } = setup();
    await expect(
      service.update(WS, USER, 'nope', { note: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a PATCH that leaves no social channel', async () => {
    const { service, id } = await saved();
    const err = await rejection(
      service.update(WS, USER, id, { channelIds: [77] }, LATER),
    );
    expect(err.message).toBe('Pick at least one channel');
  });

  it('does not judge a saved logo again, only a new one', async () => {
    const ctx = await saved({ logoMediaId: LOGO });
    ctx.repo.logoItem.mockResolvedValue({
      type: 'image',
      mimeType: 'image/png',
      isDeleted: true,
    });
    await ctx.service.update(WS, USER, ctx.id, { note: 'edit' }, LATER);
    expect(ctx.only().note).toBe('edit');
    const err = await rejection(
      ctx.service.update(
        WS,
        USER,
        ctx.id,
        { logoMediaId: '8b1b2c3d-1111-4222-8333-944455556666' },
        LATER,
      ),
    );
    expect(err.message).toBe('That logo is not in this workspace Library');
  });
});

describe('ReportsService.setShare', () => {
  async function saved() {
    const ctx = setup();
    await ctx.service.create(WS, USER, createDto(), NOW);
    return { ...ctx, id: [...ctx.rows.keys()][0] };
  }

  it('mints a 43-character token without a dot when the link is off', async () => {
    const { service, only, id } = await saved();
    const { url } = await service.setShare(WS, OTHER_USER, id, true, NOW);
    const token = only().shareToken as string;
    expect(token).toHaveLength(43);
    expect(token).not.toContain('.');
    expect(url).toBe(`https://app.schedura.ai/r/${token}`);
    expect(only().updatedBy).toBe(OTHER_USER);
  });

  it('keeps the same token when the link is already on', async () => {
    const { service, repo, only, id } = await saved();
    const first = await service.setShare(WS, USER, id, true);
    repo.update.mockClear();
    const second = await service.setShare(WS, OTHER_USER, id, true);
    expect(second).toEqual(first);
    expect(repo.update).not.toHaveBeenCalled();
    expect(only().updatedBy).toBe(USER);
  });

  it('turning it off clears the token and answers a null url', async () => {
    const { service, only, id } = await saved();
    await service.setShare(WS, USER, id, true);
    expect(await service.setShare(WS, USER, id, false)).toEqual({ url: null });
    expect(only().shareToken).toBeNull();
  });

  it('gives each link a different token', () => {
    expect(ReportsService.newShareToken()).not.toBe(
      ReportsService.newShareToken(),
    );
  });

  it('answers 404 for an unknown report', async () => {
    const { service } = setup();
    await expect(service.setShare(WS, USER, 'nope', true)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ReportsService reads', () => {
  it('list maps teamSize to the team count and reads channels and team once', async () => {
    const { service, repo, channelsRepo } = setup({ teamSize: 4 });
    await service.create(WS, USER, createDto({ channelIds: [1, 2] }), NOW);
    await service.create(WS, USER, createDto({ name: 'Two' }), NOW);
    repo.team.mockClear();
    channelsRepo.socialChannels.mockClear();
    const list = await service.list(WS);
    expect(list.map((r) => r.teamSize)).toEqual([4, 4]);
    expect(repo.team).toHaveBeenCalledTimes(1);
    expect(channelsRepo.socialChannels).toHaveBeenCalledTimes(1);
  });

  it('get answers 404 "Report not found"', async () => {
    const { service } = setup();
    await expect(service.get(WS, 'nope')).rejects.toThrow('Report not found');
  });

  it('remove answers 404 when nothing was deleted', async () => {
    const { service } = setup();
    await expect(service.remove(WS, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('builds the share url from FRONTEND_URL without its trailing slash', async () => {
    const { service, id } = await (async () => {
      const ctx = setup();
      await ctx.service.create(WS, USER, createDto(), NOW);
      return { ...ctx, id: [...ctx.rows.keys()][0] };
    })();
    const { url } = await service.setShare(WS, USER, id, true);
    expect(url?.startsWith('https://app.schedura.ai/r/')).toBe(true);
  });
});

describe('ReportsService.preview', () => {
  it('hands the normalised settings and the narrowed ids to the payload, schedule dropped', async () => {
    const { service, payloads } = setup();
    await service.preview(
      WS,
      createDto({ channelIds: [2, 77], schedule: WEEKLY }),
      NOW,
    );
    expect(payloads.payload).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        channelIds: [2],
        sections: ['brief', 'totals'],
        schedule: null,
      }),
      NOW,
    );
  });

  it('does not refuse ids that all vanished: the payload decides', async () => {
    const { service, payloads } = setup();
    await service.preview(WS, createDto({ channelIds: [77] }), NOW);
    expect(payloads.payload).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ channelIds: [] }),
      NOW,
    );
  });

  it('checks the logo and the required fields like a save', async () => {
    const svg = setup({
      logo: { type: 'image', mimeType: 'image/svg+xml', isDeleted: false },
    });
    await expect(
      svg.service.preview(WS, createDto({ logoMediaId: LOGO }), NOW),
    ).rejects.toThrow('A report logo has to be a PNG or JPG');
    expect(svg.payloads.payload).not.toHaveBeenCalled();

    const { service } = setup();
    await expect(
      service.preview(
        WS,
        createDto({ period: undefined } as Partial<CreateReportDto>),
        NOW,
      ),
    ).rejects.toThrow('period is required');
  });
});
