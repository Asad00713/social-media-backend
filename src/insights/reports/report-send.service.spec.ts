import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { EmailService } from '../../email/email.service';
import type { InsightReportRow } from '../../drizzle/schema/insight-reports.schema';
import type { GotenbergClient } from './gotenberg.client';
import { GotenbergError } from './gotenberg.client';
import { nextRunAt } from './lib/next-run';
import { settingsOf } from './lib/report-dto';
import { NoChannelsLeftError } from './report-payload.service';
import type { ReportPayloadService } from './report-payload.service';
import { ReportSendService, type ReportSendJob } from './report-send.service';
import { ReportTokensService } from './report-tokens.service';
import type { ReportPayloadDto } from './reports.dto';
import type { ReportsRepository } from './reports.repository';
import type { ReportsService } from './reports.service';

const RID = '5d0b6f0e-1111-4222-8333-944455556666';
const WS = '7a1b2c3d-1111-4222-8333-944455556666';
const NOW = new Date('2026-11-13T00:00:00Z');
const SECRET = 'report-send-spec-secret';
const TZ = 'Asia/Karachi';
/** The slot the default report is due at: before NOW. */
const DUE = new Date('2026-11-12T04:00:00Z');
const API = 'https://api.schedura.ai';

const row = (over: Partial<InsightReportRow> = {}): InsightReportRow =>
  ({
    id: RID,
    workspaceId: WS,
    name: 'Monthly review',
    channelIds: [1],
    period: 'last_30_days',
    customFrom: null,
    customTo: null,
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['brief', 'totals'],
    note: null,
    logoMediaId: null,
    optedOut: [],
    shareToken: 'sharetoken',
    cadence: 'weekly',
    weekday: 1,
    sendMinute: 540,
    sendToTeam: false,
    recipients: ['a@x.com', 'b@y.com'],
    attachPdf: true,
    nextRunAt: DUE,
    lastSentAt: null,
    lastError: null,
    createdBy: null,
    updatedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as InsightReportRow;

const payloadOf = (over: Partial<ReportPayloadDto> = {}): ReportPayloadDto =>
  ({
    name: 'Monthly review',
    logoUrl: null,
    note: null,
    window: { from: '2026-10-14', to: '2026-11-12' },
    sections: ['brief', 'totals'],
    overview: {
      brief: {
        status: 'ready',
        postsCount: 3,
        channelsCount: 1,
        segments: [{ kind: 'text', text: 'Engagement rose 12%.' }],
        sources: [],
      },
      kpis: {
        reach: { value: 1234 },
        engagements: { value: 56 },
        followers: { value: 7890 },
        postsPublished: { value: 3 },
      },
    },
    ...over,
  }) as unknown as ReportPayloadDto;

interface Opts {
  row?: InsightReportRow | null;
  team?: { userId: string; email: string; isOwner: boolean }[];
  gotenberg?: boolean;
  inactive?: boolean;
  config?: Record<string, string | undefined>;
}

function setup(opts: Opts = {}) {
  const current = opts.row === undefined ? row() : opts.row;
  const repo = {
    getById: jest.fn(() =>
      Promise.resolve(
        current
          ? { row: current, logoUrl: null, createdBy: null, updatedBy: null }
          : null,
      ),
    ),
    workspaceInfo: jest.fn(() =>
      Promise.resolve({
        name: 'Acme',
        timezone: TZ,
        isActive: !opts.inactive,
      }),
    ),
    team: jest.fn(() =>
      Promise.resolve(
        opts.team ?? [{ userId: 'u0', email: 'Owner@x.com', isOwner: true }],
      ),
    ),
    recordSent: jest.fn(() => Promise.resolve()),
    recordError: jest.fn(() => Promise.resolve()),
  };
  const payloads = {
    payload: jest.fn(() => Promise.resolve(payloadOf())),
  };
  const reports = {
    pdfFor: jest.fn(() =>
      Promise.resolve({ filename: 'acme.pdf', body: Buffer.from('%PDF-1.7') }),
    ),
  };
  const gotenberg = { isConfigured: jest.fn(() => opts.gotenberg ?? true) };
  const email = {
    sendEmail: jest.fn<
      Promise<{ success: boolean; error: string | undefined }>,
      [{ to: string }]
    >(() =>
      Promise.resolve({
        success: true as boolean,
        error: undefined as string | undefined,
      }),
    ),
  };
  const env: Record<string, string | undefined> = {
    JWT_ACCESS_SECRET: SECRET,
    API_PUBLIC_URL: `${API}/`,
    APP_URL: 'https://app-url.example.com',
    FRONTEND_URL: 'https://app.schedura.ai/',
    ...opts.config,
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const tokens = new ReportTokensService(
    new JwtService({}),
    config as unknown as ConfigService,
  );
  const service = new ReportSendService(
    repo as unknown as ReportsRepository,
    payloads as unknown as ReportPayloadService,
    reports as unknown as ReportsService,
    gotenberg as unknown as GotenbergClient,
    email as unknown as EmailService,
    tokens,
    config as unknown as ConfigService,
  );
  const pause = jest
    .spyOn(
      service as unknown as { pause: (ms: number) => Promise<void> },
      'pause',
    )
    .mockResolvedValue(undefined);
  return { service, repo, payloads, reports, gotenberg, email, tokens, pause };
}

/** `attemptsMade` of `attempts`: BullMQ's count of attempts already finished. */
function job(data: ReportSendJob, attemptsMade = 0, attempts = 3) {
  return {
    data,
    attemptsMade,
    opts: { attempts },
    updateData: jest.fn<Promise<void>, [ReportSendJob]>(() =>
      Promise.resolve(),
    ),
  };
}

const SCHEDULED: ReportSendJob = { reportId: RID, kind: 'scheduled' };
const NOW_JOB: ReportSendJob = { reportId: RID, kind: 'now' };

const sentTo = (email: ReturnType<typeof setup>['email']): string[] =>
  email.sendEmail.mock.calls.map((c) => c[0].to);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ReportSendService.run: guards', () => {
  it('answers gone for a deleted report, without throwing or sending', async () => {
    const { service, email, payloads } = setup({ row: null });
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('gone');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(payloads.payload).not.toHaveBeenCalled();
  });

  it.each([SCHEDULED, NOW_JOB])(
    'answers unscheduled when the schedule was removed (%j)',
    async (data) => {
      const { service, email, repo } = setup({
        row: row({ cadence: null, weekday: null, sendMinute: null }),
      });
      await expect(service.run(job(data), NOW)).resolves.toBe('unscheduled');
      expect(email.sendEmail).not.toHaveBeenCalled();
      expect(repo.recordError).not.toHaveBeenCalled();
      expect(repo.recordSent).not.toHaveBeenCalled();
    },
  );

  it('records the error and moves the slot when everyone opted out', async () => {
    const { service, repo, email, payloads } = setup({
      row: row({ optedOut: ['a@x.com', 'b@y.com'] }),
    });
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe(
      'no_recipients',
    );
    const next = nextRunAt(settingsOf(row()).schedule!, TZ, NOW);
    expect(repo.recordError).toHaveBeenCalledWith(
      RID,
      'No one left to send this report to',
      next,
      DUE,
    );
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(payloads.payload).not.toHaveBeenCalled();
  });

  it('leaves the slot alone for a Send now with no one to send to', async () => {
    const { service, repo } = setup({ row: row({ recipients: [] }) });
    await expect(service.run(job(NOW_JOB), NOW)).resolves.toBe('no_recipients');
    expect(repo.recordError).toHaveBeenCalledWith(
      RID,
      'No one left to send this report to',
      undefined,
      undefined,
    );
  });

  it('skips an opted-out recipient at send time', async () => {
    const { service, email } = setup({ row: row({ optedOut: ['a@x.com'] }) });
    await service.run(job(SCHEDULED), NOW);
    expect(sentTo(email)).toEqual(['b@y.com']);
  });

  it('sends to the team first, replying to the owner', async () => {
    const { service, email } = setup({
      row: row({ sendToTeam: true, recipients: ['a@x.com'] }),
      team: [
        { userId: 'u0', email: 'Owner@x.com', isOwner: true },
        { userId: 'u1', email: 'mate@x.com', isOwner: false },
      ],
    });
    await service.run(job(SCHEDULED), NOW);
    expect(sentTo(email)).toEqual(['owner@x.com', 'mate@x.com', 'a@x.com']);
    for (const [o] of email.sendEmail.mock.calls) {
      expect(o).toMatchObject({ replyTo: 'Owner@x.com' });
    }
  });
});

describe('ReportSendService.run: channels (Review Focus 3)', () => {
  it('sends nothing and builds no PDF when every channel is gone', async () => {
    const { service, email, reports, payloads, repo } = setup();
    payloads.payload.mockRejectedValue(new NoChannelsLeftError());
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('no_channels');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(reports.pdfFor).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
    const next = nextRunAt(settingsOf(row()).schedule!, TZ, NOW);
    expect(repo.recordError).toHaveBeenCalledWith(
      RID,
      'No channels left in this report',
      next,
      DUE,
    );
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('sends when one channel is left', async () => {
    const { service, email } = setup();
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('sent');
    expect(sentTo(email)).toEqual(['a@x.com', 'b@y.com']);
  });

  it('lets any other payload failure through, for BullMQ to retry', async () => {
    const { service, payloads, email, repo } = setup();
    payloads.payload.mockRejectedValue(new Error('db down'));
    await expect(service.run(job(SCHEDULED), NOW)).rejects.toThrow('db down');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(repo.recordError).not.toHaveBeenCalled();
  });
});

describe('ReportSendService.run: delivery', () => {
  it('keeps who got it, so a retry emails only the rest', async () => {
    const { service, email, repo } = setup();
    email.sendEmail
      .mockResolvedValueOnce({ success: true, error: undefined })
      .mockResolvedValueOnce({ success: false, error: 'rate limited' });

    const first = job(SCHEDULED);
    await expect(service.run(first, NOW)).rejects.toThrow(
      "Couldn't email 1 of 2 people: rate limited",
    );
    expect(first.updateData).toHaveBeenCalledWith({
      ...SCHEDULED,
      sent: ['a@x.com'],
    });
    expect(repo.recordSent).not.toHaveBeenCalled();

    email.sendEmail.mockClear();
    await expect(
      service.run(job({ ...SCHEDULED, sent: ['a@x.com'] }), NOW),
    ).resolves.toBe('sent');
    expect(sentTo(email)).toEqual(['b@y.com']);
    expect(repo.recordSent).toHaveBeenCalledTimes(1);
  });

  it('counts a resolved sendEmail with success false as a failure (F3)', async () => {
    const { service, email, repo } = setup();
    email.sendEmail.mockResolvedValue({ success: false, error: 'Resend down' });
    const j = job(SCHEDULED);
    await expect(service.run(j, NOW)).rejects.toThrow(
      "Couldn't email 2 of 2 people: Resend down",
    );
    expect(j.updateData).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
  });

  it('only records the send when everyone was emailed once a retry has nothing left', async () => {
    const { service, email, repo, payloads } = setup();
    await expect(
      service.run(job({ ...SCHEDULED, sent: ['a@x.com', 'b@y.com'] }), NOW),
    ).resolves.toBe('sent');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(payloads.payload).not.toHaveBeenCalled();
    expect(repo.recordSent).toHaveBeenCalledTimes(1);
  });

  it('pauses between sends, not before the first', async () => {
    const { service, pause } = setup({
      row: row({ recipients: ['a@x.com', 'b@y.com', 'c@z.com'] }),
    });
    await service.run(job(SCHEDULED), NOW);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(600);
  });
});

describe('ReportSendService.run: PDF', () => {
  it('attaches the PDF when Gotenberg is set up', async () => {
    const { service, email, reports } = setup();
    await service.run(job(SCHEDULED), NOW);
    expect(reports.pdfFor).toHaveBeenCalledTimes(1);
    for (const [o] of email.sendEmail.mock.calls) {
      expect(o).toMatchObject({
        attachments: [
          { filename: 'acme.pdf', content: Buffer.from('%PDF-1.7') },
        ],
      });
    }
  });

  it('sends the link only, and says so, without Gotenberg', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, email, reports } = setup({ gotenberg: false });
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('sent');
    expect(reports.pdfFor).not.toHaveBeenCalled();
    for (const [o] of email.sendEmail.mock.calls) {
      expect((o as { attachments?: unknown }).attachments).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledWith(
      `Report ${RID}: GOTENBERG_URL is unset, sending link only`,
    );
  });

  it('builds no PDF when the report does not attach one', async () => {
    const { service, reports, email } = setup({
      row: row({ attachPdf: false }),
    });
    await service.run(job(SCHEDULED), NOW);
    expect(reports.pdfFor).not.toHaveBeenCalled();
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('fails the run, for a retry, when the PDF cannot be made', async () => {
    const { service, reports, email, repo } = setup();
    reports.pdfFor.mockRejectedValue(new Error('Gotenberg timed out'));
    await expect(service.run(job(SCHEDULED), NOW)).rejects.toThrow(
      'Gotenberg timed out',
    );
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
  });
});

describe('ReportSendService.run: the slot', () => {
  it('computes the next slot from now, never back-filling a late send', async () => {
    const dueAt = new Date('2026-11-16T04:00:00Z');
    const late = new Date(dueAt.getTime() + 21 * 86_400_000);
    const { service, repo } = setup();
    await expect(service.run(job(SCHEDULED), late)).resolves.toBe('sent');
    const next = nextRunAt(settingsOf(row()).schedule!, TZ, late);
    expect(repo.recordSent).toHaveBeenCalledWith(RID, late, next, DUE);
    expect(next.getTime()).toBeGreaterThan(late.getTime());
  });

  it('leaves the slot alone for a Send now', async () => {
    const { service, repo } = setup();
    await expect(service.run(job(NOW_JOB), NOW)).resolves.toBe('sent');
    expect(repo.recordSent).toHaveBeenCalledWith(
      RID,
      NOW,
      undefined,
      undefined,
    );
  });
});

describe('ReportSendService.run: the email', () => {
  it('has no link when sharing is off, and the owner as reply-to', async () => {
    const { service, email } = setup({
      row: row({ shareToken: null, sendToTeam: true, recipients: [] }),
    });
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [
      { html: string; text: string; replyTo: string },
    ];
    expect(o.replyTo).toBe('Owner@x.com');
    expect(o.text).not.toContain('Open the report');
    expect(o.html).not.toContain('/r/');
  });

  it('links to the live report when sharing is on', async () => {
    const { service, email } = setup();
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [{ text: string }];
    expect(o.text).toContain('https://app.schedura.ai/r/sharetoken');
  });

  it('fills the brief and totals only for the sections that are on', async () => {
    const on = setup();
    await on.service.run(job(SCHEDULED), NOW);
    const [withAll] = on.email.sendEmail.mock.calls[0] as unknown as [
      { text: string },
    ];
    expect(withAll.text).toContain('In brief: Engagement rose 12%.');
    expect(withAll.text).toContain('Reach: 1,234');

    const off = setup();
    off.payloads.payload.mockResolvedValue(payloadOf({ sections: [] }));
    await off.service.run(job(SCHEDULED), NOW);
    const [without] = off.email.sendEmail.mock.calls[0] as unknown as [
      { text: string },
    ];
    expect(without.text).not.toContain('In brief');
    expect(without.text).not.toContain('Reach:');
  });

  it('leaves the totals out when the overview has none, never writing zeros', async () => {
    const { service, email, payloads } = setup();
    payloads.payload.mockResolvedValue(payloadOf({ overview: null }));
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [{ text: string }];
    expect(o.text).not.toContain('Reach:');
    expect(o.text).not.toContain(': 0');
  });

  it('gives each person their own unsubscribe link on the API origin', async () => {
    const { service, email, tokens } = setup();
    await service.run(job(SCHEDULED), NOW);
    const urls = email.sendEmail.mock.calls.map((c) => {
      const o = c[0] as unknown as {
        to: string;
        text: string;
        headers: Record<string, string>;
      };
      const url = o.headers['List-Unsubscribe'].slice(1, -1);
      expect(o.headers['List-Unsubscribe']).toBe(`<${url}>`);
      expect(o.headers['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
      expect(o.text).toContain(url);
      expect(url.startsWith(`${API}/reports/unsubscribe/`)).toBe(true);
      expect(new URL(url).protocol).toBe('https:');
      expect(
        tokens.verifyUnsubscribe(
          url.slice(`${API}/reports/unsubscribe/`.length),
        ),
      ).toEqual({ reportId: RID, email: o.to });
      return url;
    });
    expect(new Set(urls).size).toBe(2);
  });

  it('falls back to APP_URL when API_PUBLIC_URL is unset', async () => {
    const { service, email } = setup({ config: { API_PUBLIC_URL: undefined } });
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [
      { headers: Record<string, string> },
    ];
    expect(o.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/app-url\.example\.com\/reports\/unsubscribe\/.+>$/,
    );
  });

  it('is never relative: with neither set it logs and uses localhost', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, email } = setup({
      config: { API_PUBLIC_URL: undefined, APP_URL: undefined, PORT: '4100' },
    });
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [
      { headers: Record<string, string> },
    ];
    expect(o.headers['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:4100\/reports\/unsubscribe\/.+>$/,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('API_PUBLIC_URL'),
    );
  });

  it('uses port 8000 when no PORT is set either', async () => {
    const { service, email } = setup({
      config: { API_PUBLIC_URL: undefined, APP_URL: undefined },
    });
    await service.run(job(SCHEDULED), NOW);
    const [o] = email.sendEmail.mock.calls[0] as unknown as [
      { headers: Record<string, string> },
    ];
    expect(o.headers['List-Unsubscribe']).toContain(
      '<http://localhost:8000/reports/unsubscribe/',
    );
  });
});

describe('ReportSendService.markFailed', () => {
  it('records the message and moves a scheduled report to its next slot', async () => {
    const { service, repo } = setup();
    await service.markFailed(SCHEDULED, new Error('x'.repeat(300)), NOW);
    const next = nextRunAt(settingsOf(row()).schedule!, TZ, NOW);
    expect(repo.recordError).toHaveBeenCalledWith(
      RID,
      'x'.repeat(200),
      next,
      DUE,
      undefined,
    );
  });

  it('leaves the slot alone for a Send now', async () => {
    const { service, repo } = setup();
    await service.markFailed(NOW_JOB, new Error('boom'), NOW);
    expect(repo.recordError).toHaveBeenCalledWith(
      RID,
      'boom',
      undefined,
      undefined,
      undefined,
    );
  });

  it('does nothing for a report that is gone', async () => {
    const { service, repo } = setup({ row: null });
    await service.markFailed(SCHEDULED, new Error('boom'), NOW);
    expect(repo.recordError).not.toHaveBeenCalled();
  });
});

describe('ReportSendService.markFailed: the slot and the people', () => {
  it('stamps last_sent_at when some people did get the report', async () => {
    const { service, repo } = setup();
    await service.markFailed(
      { ...SCHEDULED, sent: ['a@x.com'] },
      new Error('boom'),
      NOW,
    );
    const next = nextRunAt(settingsOf(row()).schedule!, TZ, NOW);
    expect(repo.recordError).toHaveBeenCalledWith(RID, 'boom', next, DUE, NOW);
  });

  it('does not mark a report that has moved past the failed slot', async () => {
    const { service, repo } = setup({
      row: row({ nextRunAt: new Date('2026-11-20T04:00:00Z') }),
    });
    await service.markFailed(SCHEDULED, new Error('boom'), NOW);
    expect(repo.recordError).not.toHaveBeenCalled();
  });
});

describe('ReportSendService.run: a stale or suspended send', () => {
  it.each([
    ['a slot in the future', new Date('2026-11-20T04:00:00Z')],
    ['no slot at all', null],
  ])('sends and writes nothing when the report has %s', async (_n, slot) => {
    const { service, email, payloads, repo } = setup({
      row: row({ nextRunAt: slot }),
    });
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('not_due');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(payloads.payload).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
    expect(repo.recordError).not.toHaveBeenCalled();
  });

  it('still sends a Send now whatever the slot is', async () => {
    const { service } = setup({ row: row({ nextRunAt: null }) });
    await expect(service.run(job(NOW_JOB), NOW)).resolves.toBe('sent');
  });

  it('lets a retry that already emailed people finish', async () => {
    const { service, email } = setup({
      row: row({ nextRunAt: new Date('2026-11-20T04:00:00Z') }),
    });
    await expect(
      service.run(job({ ...SCHEDULED, sent: ['a@x.com'] }), NOW),
    ).resolves.toBe('sent');
    expect(sentTo(email)).toEqual(['b@y.com']);
  });

  it('writes only against the slot it read', async () => {
    const { service, repo } = setup();
    await service.run(job(SCHEDULED), NOW);
    expect(repo.recordSent).toHaveBeenCalledWith(
      RID,
      NOW,
      expect.any(Date),
      DUE,
    );
  });

  it('emails nobody for a suspended workspace and writes nothing', async () => {
    const { service, email, payloads, repo } = setup({ inactive: true });
    await expect(service.run(job(SCHEDULED), NOW)).resolves.toBe('inactive');
    await expect(service.run(job(NOW_JOB), NOW)).resolves.toBe('inactive');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(payloads.payload).not.toHaveBeenCalled();
    expect(repo.recordSent).not.toHaveBeenCalled();
    expect(repo.recordError).not.toHaveBeenCalled();
  });
});

describe('ReportSendService.run: pacing and counts', () => {
  const three = () =>
    setup({ row: row({ recipients: ['a@x.com', 'b@y.com', 'c@z.com'] }) });

  it('waits longer after Resend says slow down', async () => {
    const { service, email, pause } = three();
    email.sendEmail
      .mockResolvedValueOnce({
        success: false,
        error: 'Too many requests. You can only make 2 requests per second.',
      })
      .mockResolvedValue({ success: true, error: undefined });
    await expect(service.run(job(SCHEDULED), NOW)).rejects.toThrow(
      "Couldn't email 1 of 3 people: Too many requests",
    );
    expect(pause.mock.calls.map((c) => c[0])).toEqual([2000, 600]);
  });

  it('recognises a 429 in the message', async () => {
    const { service, email, pause } = three();
    email.sendEmail
      .mockResolvedValueOnce({ success: false, error: 'HTTP 429' })
      .mockResolvedValue({ success: true, error: undefined });
    await expect(service.run(job(SCHEDULED), NOW)).rejects.toThrow();
    expect(pause.mock.calls[0][0]).toBe(2000);
  });

  it('keeps the normal gap after any other failure', async () => {
    const { service, email, pause } = three();
    email.sendEmail
      .mockResolvedValueOnce({ success: false, error: 'mailbox full' })
      .mockResolvedValue({ success: true, error: undefined });
    await expect(service.run(job(SCHEDULED), NOW)).rejects.toThrow();
    expect(pause.mock.calls.map((c) => c[0])).toEqual([600, 600]);
  });

  it('counts the whole list in the final message, not only this attempt', async () => {
    const { service, email } = three();
    email.sendEmail.mockResolvedValue({ success: false, error: 'boom' });
    await expect(
      service.run(job({ ...SCHEDULED, sent: ['a@x.com'] }), NOW),
    ).rejects.toThrow("Couldn't email 2 of 3 people: boom");
  });
});

describe('ReportSendService.run: a PDF that fails', () => {
  const raw = 'answered 500 from http://gotenberg.internal:3000/forms/chromium';

  it('throws a friendly message, never Gotenberg text, while attempts remain', async () => {
    const { service, reports, email } = setup();
    reports.pdfFor.mockRejectedValue(new GotenbergError(raw));
    const err = await service
      .run(job(SCHEDULED, 0), NOW)
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("Couldn't make the PDF. Try again.");
    expect((err as Error).message).not.toContain('gotenberg.internal');
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('says it took too long for a timeout', async () => {
    const { service, reports } = setup();
    reports.pdfFor.mockRejectedValue(new GotenbergError('slow', 'timeout'));
    await expect(service.run(job(SCHEDULED, 1), NOW)).rejects.toThrow(
      'The PDF took too long. Try again.',
    );
  });

  it('sends the link without the attachment on the last attempt, and logs it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, reports, email, repo } = setup();
    reports.pdfFor.mockRejectedValue(new GotenbergError(raw));
    await expect(service.run(job(SCHEDULED, 2), NOW)).resolves.toBe('sent');
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    for (const [o] of email.sendEmail.mock.calls) {
      expect((o as { attachments?: unknown }).attachments).toBeUndefined();
    }
    expect(repo.recordSent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `Report ${RID}: PDF failed on the last attempt, sending link only`,
    );
  });

  it('still fails on the last attempt for something that is not the PDF', async () => {
    const { service, reports } = setup();
    reports.pdfFor.mockRejectedValue(new Error('Workspace not found'));
    await expect(service.run(job(SCHEDULED, 2), NOW)).rejects.toThrow(
      'Workspace not found',
    );
  });
});
