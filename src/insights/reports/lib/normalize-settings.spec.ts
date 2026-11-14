import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { CreateReportDto } from '../dto/report-settings.dto';
import type { ReportSchedule, ReportSettings } from '../reports.dto';
import { normalizeSettings, settingsFromCreate } from './normalize-settings';

const NOW = new Date('2026-11-13T12:00:00Z');

const SCHEDULE: ReportSchedule = {
  cadence: 'weekly',
  weekday: 1,
  sendMinute: 540,
  sendToTeam: true,
  recipients: [],
  attachPdf: true,
};

function settings(over: Partial<ReportSettings> = {}): ReportSettings {
  return {
    name: 'Monthly review',
    channelIds: [1, 2],
    period: 'last_month',
    customFrom: null,
    customTo: null,
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['brief', 'totals'],
    note: null,
    logoMediaId: null,
    schedule: null,
    ...over,
  };
}

function withSchedule(over: Partial<ReportSchedule>): ReportSettings {
  return settings({ schedule: { ...SCHEDULE, ...over } });
}

function rejection(fn: () => unknown): BadRequestException {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return e as BadRequestException;
  }
  throw new Error('expected a BadRequestException');
}

describe('normalizeSettings', () => {
  it('dedupes sections and puts them in canonical order', () => {
    const out = normalizeSettings(
      settings({ sections: ['how_we_count', 'totals', 'brief', 'totals'] }),
      NOW,
    );
    expect(out.sections).toEqual(['brief', 'totals', 'how_we_count']);
  });

  it('dedupes channel ids, keeping first-seen order', () => {
    const out = normalizeSettings(
      settings({ channelIds: [3, 1, 3, 2, 1] }),
      NOW,
    );
    expect(out.channelIds).toEqual([3, 1, 2]);
  });

  it('trims, lowercases and dedupes recipients', () => {
    const out = normalizeSettings(
      withSchedule({
        recipients: [' Sara@Acme.com', 'sara@acme.com', 'b@x.io'],
      }),
      NOW,
    );
    expect(out.schedule?.recipients).toEqual(['sara@acme.com', 'b@x.io']);
  });

  it('stores no dates for a period that is not custom', () => {
    const out = normalizeSettings(
      settings({
        period: 'last_month',
        customFrom: '2026-10-01',
        customTo: '2026-10-31',
      }),
      NOW,
    );
    expect(out.customFrom).toBeNull();
    expect(out.customTo).toBeNull();
  });

  it('keeps the dates of a valid custom range', () => {
    const out = normalizeSettings(
      settings({
        period: 'custom',
        customFrom: '2026-10-01',
        customTo: '2026-10-31',
      }),
      NOW,
    );
    expect(out.customFrom).toBe('2026-10-01');
    expect(out.customTo).toBe('2026-10-31');
  });

  it('rejects a blank name', () => {
    const e = rejection(() =>
      normalizeSettings(settings({ name: '   ' }), NOW),
    );
    expect(e.message).toBe('Give the report a name');
  });

  it('trims the name', () => {
    expect(normalizeSettings(settings({ name: '  Q3  ' }), NOW).name).toBe(
      'Q3',
    );
  });

  it('rejects a weekly schedule without a weekday', () => {
    const e = rejection(() =>
      normalizeSettings(
        withSchedule({ cadence: 'weekly', weekday: null }),
        NOW,
      ),
    );
    expect(e.message).toBe('Pick a weekday for a weekly report');
  });

  it('keeps a weekly weekday, including Sunday (0)', () => {
    const out = normalizeSettings(
      withSchedule({ cadence: 'weekly', weekday: 0 }),
      NOW,
    );
    expect(out.schedule?.weekday).toBe(0);
  });

  it('forces a monthly weekday to null', () => {
    const out = normalizeSettings(
      withSchedule({ cadence: 'monthly', weekday: 3 }),
      NOW,
    );
    expect(out.schedule?.weekday).toBeNull();
  });

  it('rejects a 93-day custom range', () => {
    const e = rejection(() =>
      normalizeSettings(
        settings({
          period: 'custom',
          customFrom: '2026-07-01',
          customTo: '2026-10-01',
        }),
        NOW,
      ),
    );
    expect(e.message).toBe('A report range can be at most 92 days');
  });

  it('turns a blank note into null and trims a real one', () => {
    expect(normalizeSettings(settings({ note: '  ' }), NOW).note).toBeNull();
    expect(normalizeSettings(settings({ note: ' hi ' }), NOW).note).toBe('hi');
  });

  it('does not change its input', () => {
    const input = settings({
      sections: ['totals', 'brief'],
      channelIds: [1, 1],
    });
    normalizeSettings(input, NOW);
    expect(input.sections).toEqual(['totals', 'brief']);
    expect(input.channelIds).toEqual([1, 1]);
  });
});

describe('settingsFromCreate', () => {
  const body = {
    name: 'Monthly review',
    channelIds: [1],
    period: 'last_30_days',
    compare: 'none',
    chartMetric: 'views',
    sections: ['totals'],
  };

  function create(over: Record<string, unknown> = {}): CreateReportDto {
    return plainToInstance(CreateReportDto, { ...body, ...over });
  }

  it('fills every missing optional field with null', () => {
    expect(settingsFromCreate(create())).toEqual({
      ...body,
      customFrom: null,
      customTo: null,
      note: null,
      logoMediaId: null,
      schedule: null,
    });
  });

  it('fills a missing weekday of a schedule with null', () => {
    const out = settingsFromCreate(
      create({
        schedule: {
          cadence: 'monthly',
          sendMinute: 60,
          sendToTeam: false,
          recipients: ['a@b.io'],
          attachPdf: false,
        },
      }),
    );
    expect(out.schedule).toEqual({
      cadence: 'monthly',
      weekday: null,
      sendMinute: 60,
      sendToTeam: false,
      recipients: ['a@b.io'],
      attachPdf: false,
    });
  });

  it('treats a null schedule as no schedule', () => {
    expect(settingsFromCreate(create({ schedule: null })).schedule).toBeNull();
  });

  it.each([
    'name',
    'channelIds',
    'period',
    'compare',
    'chartMetric',
    'sections',
  ])('rejects a body without %s', (field) => {
    const e = rejection(() =>
      settingsFromCreate(create({ [field]: undefined })),
    );
    expect(e.message).toBe(`${field} is required`);
  });

  it('rejects a required field sent as null', () => {
    const e = rejection(() => settingsFromCreate(create({ name: null })));
    expect(e.message).toBe('name is required');
  });
});
