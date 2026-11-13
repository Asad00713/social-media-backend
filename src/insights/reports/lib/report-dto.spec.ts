import type { InsightReportRow } from '../../../drizzle/schema/insight-reports.schema';
import { settingsOf, toReportDto, type ReportRecord } from './report-dto';

const CTX = {
  socialIds: new Set([1, 3]),
  teamSize: 4,
  frontendUrl: 'https://app.schedura.ai',
};

function row(over: Partial<InsightReportRow> = {}): InsightReportRow {
  return {
    id: 'r1',
    workspaceId: 'w1',
    name: 'Monthly review',
    channelIds: [3, 9, 1],
    period: 'last_month',
    customFrom: null,
    customTo: null,
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['brief', 'totals'],
    note: null,
    logoMediaId: null,
    optedOut: [],
    shareToken: null,
    cadence: null,
    weekday: null,
    sendMinute: null,
    sendToTeam: false,
    recipients: [],
    attachPdf: true,
    nextRunAt: null,
    lastSentAt: null,
    lastError: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-10-02T08:00:00Z'),
    updatedAt: new Date('2026-10-03T08:00:00Z'),
    ...over,
  };
}

function record(over: Partial<InsightReportRow> = {}): ReportRecord {
  return { row: row(over), logoUrl: null, createdBy: null, updatedBy: null };
}

describe('toReportDto', () => {
  it('narrows channelIds to the social channels, keeping stored order', () => {
    expect(toReportDto(record(), CTX).channelIds).toEqual([3, 1]);
  });

  it('builds the share url from the token, or null when the link is off', () => {
    expect(toReportDto(record({ shareToken: 'abc' }), CTX).shareUrl).toBe(
      'https://app.schedura.ai/r/abc',
    );
    expect(toReportDto(record({ shareToken: null }), CTX).shareUrl).toBeNull();
  });

  it('has no schedule when cadence is null', () => {
    expect(toReportDto(record(), CTX).schedule).toBeNull();
  });

  it('maps a weekly row to its schedule', () => {
    const dto = toReportDto(
      record({
        cadence: 'weekly',
        weekday: 1,
        sendMinute: 540,
        sendToTeam: true,
        recipients: ['a@acme.com'],
        attachPdf: false,
      }),
      CTX,
    );
    expect(dto.schedule).toEqual({
      cadence: 'weekly',
      weekday: 1,
      sendMinute: 540,
      sendToTeam: true,
      recipients: ['a@acme.com'],
      attachPdf: false,
    });
  });

  it('maps a monthly row with a null weekday', () => {
    const dto = toReportDto(
      record({ cadence: 'monthly', weekday: null, sendMinute: 0 }),
      CTX,
    );
    expect(dto.schedule).toMatchObject({
      cadence: 'monthly',
      weekday: null,
      sendMinute: 0,
    });
  });

  it('writes instants as ISO strings, and an absent one as null', () => {
    const dto = toReportDto(
      record({
        nextRunAt: new Date('2026-11-16T04:00:00Z'),
        lastSentAt: new Date('2026-11-09T04:00:00Z'),
      }),
      CTX,
    );
    expect(dto.nextRunAt).toBe('2026-11-16T04:00:00.000Z');
    expect(dto.lastSentAt).toBe('2026-11-09T04:00:00.000Z');
    expect(dto.createdAt).toBe('2026-10-02T08:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-10-03T08:00:00.000Z');
    expect(toReportDto(record(), CTX).nextRunAt).toBeNull();
    expect(toReportDto(record(), CTX).lastSentAt).toBeNull();
  });

  it('carries the joined logo url, the people, the team size and the opt-outs', () => {
    const dto = toReportDto(
      {
        row: row({
          optedOut: ['x@acme.com'],
          lastError: 'No channels left in this report',
        }),
        logoUrl: 'https://cdn.example/logo.png',
        createdBy: { id: 'u1', name: 'Sara' },
        updatedBy: { id: 'u2', name: 'Omar' },
      },
      CTX,
    );
    expect(dto).toMatchObject({
      id: 'r1',
      logoUrl: 'https://cdn.example/logo.png',
      createdBy: { id: 'u1', name: 'Sara' },
      updatedBy: { id: 'u2', name: 'Omar' },
      teamSize: 4,
      optedOut: ['x@acme.com'],
      lastError: 'No channels left in this report',
    });
  });

  it('never leaks the workspace id or the raw token', () => {
    const json = JSON.stringify(
      toReportDto(record({ shareToken: 'tok' }), CTX),
    );
    expect(json).not.toContain('workspaceId');
    expect(json).not.toContain('shareToken');
  });
});

describe('settingsOf', () => {
  it('returns the stored channelIds untouched (narrowing is the DTO step)', () => {
    expect(settingsOf(row()).channelIds).toEqual([3, 9, 1]);
  });
});
