import type { ConfigService } from '@nestjs/config';
import { AppLinks } from '../../../email/links/app-links';
import type { Brief } from '../../lib/brief';
import {
  briefTextOf,
  reportEmail,
  totalsOf,
  type ReportEmailInput,
} from './report-email';

const UNSUB = 'https://api.schedura.ai/reports/unsubscribe/tok';

const LINKS = new AppLinks({
  get: () => undefined,
} as unknown as ConfigService);

function input(over: Partial<ReportEmailInput> = {}): ReportEmailInput {
  return {
    reportName: 'Acme report',
    workspaceName: 'Acme',
    window: { from: '2026-11-01', to: '2026-11-30' },
    logoUrl: null,
    briefText: null,
    totals: { reach: 12345, engagements: 678, followers: 9000, posts: 14 },
    shareUrl: 'https://app.schedura.ai/r/abc',
    note: null,
    unsubscribeUrl: UNSUB,
    ...over,
  };
}

const email = (over: Partial<ReportEmailInput> = {}) =>
  reportEmail(input(over), LINKS);

describe('reportEmail', () => {
  it('puts the name and window in the subject', async () => {
    expect((await email()).subject).toBe('Acme report: Nov 1 – Nov 30');
  });

  it('escapes the name and the note in the HTML', async () => {
    const { html } = await email({
      reportName: '<script>x</script>',
      note: 'a & b',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('escapes the workspace name, the brief and the logo url', async () => {
    const { html } = await email({
      workspaceName: 'A<b>',
      briefText: '<i>up</i>',
      logoUrl: 'https://x/l.png" onerror="y',
    });
    expect(html).toContain('A&lt;b&gt;');
    expect(html).toContain('&lt;i&gt;up&lt;/i&gt;');
    expect(html).not.toContain('onerror="y');
  });

  it('shows the workspace logo only when set, after the Schedura mark', async () => {
    expect((await email()).html).not.toContain('cdn.x/logo.png');
    const { html } = await email({ logoUrl: 'https://cdn.x/logo.png' });
    expect(html).toContain('src="https://cdn.x/logo.png"');
    expect(html.indexOf('/email/logo.png')).toBeLessThan(
      html.indexOf('src="https://cdn.x/logo.png"'),
    );
  });

  it('shows the In brief text only when given', async () => {
    expect((await email()).html).not.toContain('In brief');
    const { html, text } = await email({ briefText: 'Reach rose 12%.' });
    expect(html).toContain('In brief');
    expect(html).toContain('Reach rose 12%.');
    expect(text).toContain('Reach rose 12%.');
  });

  it('formats the four totals in en-US', async () => {
    const { html, text } = await email();
    for (const label of ['Reach', 'Engagements', 'Followers', 'Posts']) {
      expect(html).toContain(label);
      expect(text).toContain(label);
    }
    expect(html).toContain('12,345');
    expect(text).toContain('Reach 12,345');
  });

  it('leaves the totals out when there are none', async () => {
    const { html, text } = await email({ totals: null });
    expect(html).not.toContain('Engagements');
    expect(text).not.toContain('Engagements');
  });

  it('omits the button when there is no share url', async () => {
    const { html, text } = await email({ shareUrl: null });
    expect(html).not.toContain('Open the report');
    expect(text).not.toContain('Open the report');
  });

  it('has the button and the url when a share url is given', async () => {
    const { html, text } = await email();
    expect(html).toContain('Open the report');
    expect(html).toContain('href="https://app.schedura.ai/r/abc"');
    expect(html.match(/data-email-button/g)).toHaveLength(1);
    expect(text).toContain('Open the report https://app.schedura.ai/r/abc');
  });

  it('shows a missing total as a dash, never 0', async () => {
    const { html, text } = await email({
      totals: { reach: 5, engagements: 6, followers: null, posts: 7 },
    });
    expect(html).toMatch(/Followers[\s\S]*?>—</);
    expect(html).not.toContain('>0<');
    expect(text).toContain('Followers —');
  });

  it('shows a real zero as 0', async () => {
    const { text } = await email({
      totals: { reach: 0, engagements: 0, followers: 0, posts: 0 },
    });
    expect(text).toContain('Posts 0');
  });

  it('says why the person gets it and links to stop it, in both bodies', async () => {
    const { html, text } = await email();
    const sentence = 'You get this because Acme added you to this report.';
    expect(html).toContain(sentence);
    expect(text).toContain(sentence);
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html).toContain('Stop receiving this report');
    expect(text).toContain(`Stop receiving this report ${UNSUB}`);
  });

  it('ends with the shared footer, help and privacy links included', async () => {
    const { html, text } = await email();
    expect(html).toContain('Schedura · schedura.ai');
    expect(text).toContain('Schedura · schedura.ai');
    expect(html).toContain('href="https://schedura.ai/help"');
    expect(html).toContain('href="https://schedura.ai/privacy"');
  });

  it('carries the one-click unsubscribe headers', async () => {
    expect((await email()).headers).toEqual({
      'List-Unsubscribe': '<https://api.schedura.ai/reports/unsubscribe/tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('puts the note after the button and before the footer', async () => {
    const { text } = await email({ note: 'Thanks all' });
    expect(text.indexOf('Thanks all')).toBeGreaterThan(
      text.indexOf('Open the report'),
    );
    expect(text.indexOf('Thanks all')).toBeLessThan(
      text.indexOf('You get this because'),
    );
  });

  it('keeps a note on its own lines in the HTML', async () => {
    const { html } = await email({ note: 'Thanks all' });
    expect(html).toContain('white-space:pre-line');
  });

  it('treats a blank note and a blank brief as absent, in both bodies', async () => {
    const { html, text } = await email({ note: '  \n ', briefText: ' ' });
    expect(html).not.toContain('In brief');
    expect(html).not.toContain('white-space:pre-line');
    expect(text).not.toContain('In brief');
  });

  it('trims a note and a brief that have padding', async () => {
    const { text } = await email({ note: '  Thanks  ', briefText: ' Up. ' });
    expect(text).toMatch(/In brief\s+Up\./);
    expect(text).toMatch(/\n\nThanks\n\n/);
  });

  it('names the workspace in the logo alt text', async () => {
    const { html } = await email({
      logoUrl: 'https://cdn.x/l.png',
      workspaceName: 'A"cme',
    });
    expect(html).toContain('alt="A&quot;cme"');
  });

  it('is a full document with a preheader after the subject', async () => {
    const { html } = await email({ reportName: 'A<b>' });
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html).toContain('Nov 1 – Nov 30 · Acme');
  });

  it('declares a viewport so a phone shows the column at full width', async () => {
    const { html } = await email();
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1"',
    );
  });

  it('lays the HTML out as logo, name, window, brief, totals, button, note', async () => {
    const { html } = await email({
      logoUrl: 'https://cdn.x/l.png',
      briefText: 'Brief line',
      note: 'Note line',
    });
    const at = (needle: string) => html.indexOf(needle);
    const order = [
      'src="https://cdn.x/l.png"',
      '<h1',
      'Nov 1 – Nov 30</p>',
      'Brief line',
      'Engagements',
      'Open the report</span>',
      'Note line',
      'You get this because',
    ].map(at);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('uses inline styles and no scripts', async () => {
    const { html } = await email();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('rel="stylesheet"');
  });
});

describe('briefTextOf', () => {
  it("joins a ready brief's segments", () => {
    const brief: Brief = {
      status: 'ready',
      postsCount: 3,
      channelsCount: 1,
      segments: [
        { kind: 'text', text: 'Reach ' },
        { kind: 'metric', text: 'rose 12%' },
        { kind: 'text', text: '.' },
      ],
      sources: [],
    };
    expect(briefTextOf(brief)).toBe('Reach rose 12%.');
  });

  it('reads the text of a brief that is not ready', () => {
    expect(
      briefTextOf({
        status: 'not_enough',
        postsCount: 0,
        text: 'Not enough posts yet.',
        suggestDays: 30,
      }),
    ).toBe('Not enough posts yet.');
  });
});

describe('totalsOf', () => {
  it('reads reach, engagements, followers and posts', () => {
    const kpis = {
      reach: { value: 10, previous: null, deltaPct: null },
      engagements: { value: 20, previous: null, deltaPct: null },
      followers: {
        value: 30,
        gained: null,
        growthPct: null,
        previousGained: null,
      },
      postsPublished: {
        value: 40,
        previous: null,
        deltaPct: null,
        deltaAbs: null,
      },
    } as unknown as Parameters<typeof totalsOf>[0];
    expect(totalsOf(kpis)).toEqual({
      reach: 10,
      engagements: 20,
      followers: 30,
      posts: 40,
    });
  });
});
