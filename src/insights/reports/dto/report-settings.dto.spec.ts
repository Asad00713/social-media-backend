import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateReportDto,
  ShareReportDto,
  UpdateReportDto,
} from './report-settings.dto';

const SCHEDULE = {
  cadence: 'weekly',
  weekday: 1,
  sendMinute: 540,
  sendToTeam: true,
  recipients: ['a@acme.com'],
  attachPdf: true,
};

const FULL = {
  name: 'Monthly review',
  channelIds: [1, 2],
  period: 'custom',
  customFrom: '2026-10-01',
  customTo: '2026-10-31',
  compare: 'usual',
  chartMetric: 'reach',
  sections: ['brief', 'totals', 'main_chart'],
  note: 'For the board',
  logoMediaId: '3f2b8c1e-5a4d-4f0e-9a43-6a1d2c7b9e10',
  schedule: SCHEDULE,
};

/** Failing property names, validated the way the app's ValidationPipe does. */
async function invalid<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('CreateReportDto', () => {
  it('accepts a valid full body', async () => {
    expect(await invalid(CreateReportDto, FULL)).toEqual([]);
  });

  it('accepts a null schedule', async () => {
    expect(await invalid(CreateReportDto, { ...FULL, schedule: null })).toEqual(
      [],
    );
  });

  it('rejects a send minute that is not a multiple of 15', async () => {
    expect(
      await invalid(CreateReportDto, {
        ...FULL,
        schedule: { ...SCHEDULE, sendMinute: 7 },
      }),
    ).toEqual(['schedule']);
  });

  it('rejects a send minute past 23:45', async () => {
    expect(
      await invalid(CreateReportDto, {
        ...FULL,
        schedule: { ...SCHEDULE, sendMinute: 1440 },
      }),
    ).toEqual(['schedule']);
  });

  it('rejects eleven recipients and accepts ten', async () => {
    const mails = (n: number) =>
      Array.from({ length: n }, (_, i) => `p${i}@acme.com`);
    expect(
      await invalid(CreateReportDto, {
        ...FULL,
        schedule: { ...SCHEDULE, recipients: mails(11) },
      }),
    ).toEqual(['schedule']);
    expect(
      await invalid(CreateReportDto, {
        ...FULL,
        schedule: { ...SCHEDULE, recipients: mails(10) },
      }),
    ).toEqual([]);
  });

  it('rejects a recipient that is not an email', async () => {
    expect(
      await invalid(CreateReportDto, {
        ...FULL,
        schedule: { ...SCHEDULE, recipients: ['nope'] },
      }),
    ).toEqual(['schedule']);
  });

  it('rejects a section that does not exist', async () => {
    expect(
      await invalid(CreateReportDto, { ...FULL, sections: ['goals'] }),
    ).toEqual(['sections']);
  });

  it('rejects no channels', async () => {
    expect(await invalid(CreateReportDto, { ...FULL, channelIds: [] })).toEqual(
      ['channelIds'],
    );
  });

  it('rejects channel ids sent as strings', async () => {
    expect(
      await invalid(CreateReportDto, { ...FULL, channelIds: ['1'] }),
    ).toEqual(['channelIds']);
  });

  it('rejects a 51st channel', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(
      await invalid(CreateReportDto, { ...FULL, channelIds: ids }),
    ).toEqual(['channelIds']);
  });

  it('rejects a name over 80 characters and a note over 500', async () => {
    expect(
      await invalid(CreateReportDto, { ...FULL, name: 'x'.repeat(81) }),
    ).toEqual(['name']);
    expect(
      await invalid(CreateReportDto, { ...FULL, note: 'x'.repeat(501) }),
    ).toEqual(['note']);
  });

  it('rejects an unknown period, compare, chart metric and logo id', async () => {
    expect(
      (
        await invalid(CreateReportDto, {
          ...FULL,
          period: 'last_year',
          compare: 'yoy',
          chartMetric: 'clicks',
          logoMediaId: 'not-a-uuid',
        })
      ).sort(),
    ).toEqual(['chartMetric', 'compare', 'logoMediaId', 'period']);
  });

  it('rejects a field it does not know', async () => {
    expect(
      await invalid(CreateReportDto, { ...FULL, workspaceId: 'x' }),
    ).toEqual(['workspaceId']);
  });
});

describe('UpdateReportDto', () => {
  it('accepts an empty body', async () => {
    expect(await invalid(UpdateReportDto, {})).toEqual([]);
  });

  it('accepts a null schedule (turn it off)', async () => {
    expect(await invalid(UpdateReportDto, { schedule: null })).toEqual([]);
  });

  it('still validates the fields it is given', async () => {
    expect(
      (
        await invalid(UpdateReportDto, {
          channelIds: [],
          sections: ['goals'],
          name: 'x'.repeat(81),
        })
      ).sort(),
    ).toEqual(['channelIds', 'name', 'sections']);
  });
});

describe('ShareReportDto', () => {
  it('needs a boolean', async () => {
    expect(await invalid(ShareReportDto, { enabled: true })).toEqual([]);
    expect(await invalid(ShareReportDto, { enabled: 'yes' })).toEqual([
      'enabled',
    ]);
    expect(await invalid(ShareReportDto, {})).toEqual(['enabled']);
  });
});
