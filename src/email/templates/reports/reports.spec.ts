import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
import { insightReport, reportFooterReason } from './insight-report';
import { leadDelivered, leadFooterReason } from './lead-delivered';
import { REPORTS_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: { reason: 'Why line', links: [] },
};

describe('reports templates', () => {
  it('registers the insight report and the lead email in the reports group', () => {
    expect(REPORTS_TEMPLATES).toEqual([insightReport, leadDelivered]);
    expect(insightReport.category).toBe('reports');
    expect(leadDelivered.category).toBe('leads');
  });

  it('are mandatory plain-footer mail: no preference toggles them', () => {
    for (const def of [insightReport, leadDelivered]) {
      expect(def.event).toBeNull();
      expect(def.footer).toBe('plain');
    }
  });

  it('give the sender the footer sentence the def uses', () => {
    expect(insightReport.footerReason?.(insightReport.fixture)).toBe(
      reportFooterReason(insightReport.fixture.workspaceName),
    );
    expect(leadDelivered.footerReason?.(leadDelivered.fixture)).toBe(
      leadFooterReason(leadDelivered.fixture.formName),
    );
  });

  it('keep the insight report subject: name, then the window', async () => {
    const r = await renderEmail(insightReport, insightReport.fixture, ctx);
    expect(r.subject).toBe('Monthly review: Oct 14 – Nov 12');
  });

  it('render a report with nothing optional, and a lead with no fields', async () => {
    const report = await renderEmail(
      insightReport,
      {
        ...insightReport.fixture,
        briefText: null,
        totals: null,
        shareUrl: null,
        note: null,
      },
      ctx,
    );
    expect(report.html).not.toContain('In brief');
    expect(report.html).not.toContain('data-email-button');
    const empty = await renderEmail(
      leadDelivered,
      { ...leadDelivered.fixture, fields: [] },
      ctx,
    );
    expect(empty.html).toContain('This lead has no fields.');
  });
});
