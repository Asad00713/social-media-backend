import type { Brief } from '../../lib/brief';
import {
  briefTextOf,
  reportEmail,
  totalsOf,
  type ReportEmailInput,
} from './report-email';

const UNSUB = 'https://api.schedura.ai/reports/unsubscribe/tok';

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

describe('reportEmail', () => {
  it('puts the name and window in the subject', () => {
    expect(reportEmail(input()).subject).toBe('Acme report: Nov 1 – Nov 30');
  });

  it('escapes the name and the note in the HTML', () => {
    const { html } = reportEmail(
      input({ reportName: '<script>x</script>', note: 'a & b' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('escapes the workspace name, the brief and the logo url', () => {
    const { html } = reportEmail(
      input({
        workspaceName: 'A<b>',
        briefText: '<i>up</i>',
        logoUrl: 'https://x/l.png" onerror="y',
      }),
    );
    expect(html).toContain('A&lt;b&gt;');
    expect(html).toContain('&lt;i&gt;up&lt;/i&gt;');
    expect(html).not.toContain('onerror="y');
  });

  it('shows the logo only when set', () => {
    expect(reportEmail(input()).html).not.toContain('<img');
    expect(
      reportEmail(input({ logoUrl: 'https://cdn.x/logo.png' })).html,
    ).toContain('<img src="https://cdn.x/logo.png"');
  });

  it('shows the In brief text only when given', () => {
    expect(reportEmail(input()).html).not.toContain('In brief');
    const { html, text } = reportEmail(input({ briefText: 'Reach rose 12%.' }));
    expect(html).toContain('Reach rose 12%.');
    expect(text).toContain('Reach rose 12%.');
  });

  it('formats the four totals in en-US', () => {
    const { html, text } = reportEmail(input());
    for (const label of ['Reach', 'Engagements', 'Followers', 'Posts']) {
      expect(html).toContain(label);
      expect(text).toContain(label);
    }
    expect(html).toContain('12,345');
    expect(text).toContain('Reach: 12,345');
  });

  it('leaves the totals out when there are none', () => {
    const { html, text } = reportEmail(input({ totals: null }));
    expect(html).not.toContain('Engagements');
    expect(text).not.toContain('Engagements');
  });

  it('omits the button when there is no share url', () => {
    const { html, text } = reportEmail(input({ shareUrl: null }));
    expect(html).not.toContain('Open the report');
    expect(text).not.toContain('Open the report');
  });

  it('has the button and the url when a share url is given', () => {
    const { html, text } = reportEmail(input());
    expect(html).toContain('Open the report');
    expect(html).toContain('href="https://app.schedura.ai/r/abc"');
    expect(text).toContain('Open the report: https://app.schedura.ai/r/abc');
  });

  it('shows a missing total as a dash, never 0', () => {
    const { html, text } = reportEmail(
      input({
        totals: { reach: 5, engagements: 6, followers: null, posts: 7 },
      }),
    );
    expect(html).toMatch(/Followers[\s\S]*?>—</);
    expect(html).not.toContain('>0<');
    expect(text).toContain('Followers: —');
  });

  it('shows a real zero as 0', () => {
    const { text } = reportEmail(
      input({
        totals: { reach: 0, engagements: 0, followers: 0, posts: 0 },
      }),
    );
    expect(text).toContain('Posts: 0');
  });

  it('says why the person gets it and links to stop it, in both bodies', () => {
    const { html, text } = reportEmail(input());
    const sentence = 'You get this because Acme added you to this report.';
    expect(html).toContain(sentence);
    expect(text).toContain(sentence);
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html).toContain('Stop receiving this report');
    expect(text).toContain(`Stop receiving this report: ${UNSUB}`);
  });

  it('carries the one-click unsubscribe headers', () => {
    expect(reportEmail(input()).headers).toEqual({
      'List-Unsubscribe': '<https://api.schedura.ai/reports/unsubscribe/tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('puts the note after the button and before the footer', () => {
    const { text } = reportEmail(input({ note: 'Thanks all' }));
    expect(text.indexOf('Thanks all')).toBeGreaterThan(
      text.indexOf('Open the report'),
    );
    expect(text.indexOf('Thanks all')).toBeLessThan(
      text.indexOf('You get this because'),
    );
  });

  it('treats a blank note and a blank brief as absent, in both bodies', () => {
    const { html, text } = reportEmail(
      input({ note: '  \n ', briefText: ' ' }),
    );
    expect(html).not.toContain('In brief');
    expect(html).not.toContain('white-space:pre-line');
    expect(text).not.toContain('In brief');
    // name, window, totals, button, footer: one blank line between each.
    expect(text.split('\n\n')).toHaveLength(5);
  });

  it('trims a note and a brief that have padding', () => {
    const { text } = reportEmail(
      input({ note: '  Thanks  ', briefText: ' Up. ' }),
    );
    expect(text).toContain('In brief: Up.');
    expect(text).toContain('\n\nThanks\n\n');
  });

  it('names the workspace in the logo alt text', () => {
    const { html } = reportEmail(
      input({ logoUrl: 'https://cdn.x/l.png', workspaceName: 'A"cme' }),
    );
    expect(html).toContain('alt="A&quot;cme"');
  });

  it('is a full document with a charset, viewport and title', () => {
    const { html } = reportEmail(input({ reportName: 'A<b>' }));
    expect(html).toContain('<head><meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>A&lt;b&gt;: Nov 1 – Nov 30</title>');
  });

  it('lays the HTML out as logo, name, window, brief, totals, button, note', () => {
    const { html } = reportEmail(
      input({
        logoUrl: 'https://cdn.x/l.png',
        briefText: 'Brief line',
        note: 'Note line',
      }),
    );
    const at = (needle: string) => html.indexOf(needle);
    const order = [
      '<img',
      '<h1',
      'Nov 1 – Nov 30</p>',
      'Brief line',
      'Engagements',
      'Open the report</a>',
      'Note line',
      'You get this because',
    ].map(at);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('uses inline styles only', () => {
    const { html } = reportEmail(input());
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<link');
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
