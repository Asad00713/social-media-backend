import { Img, Text } from '@react-email/components';
import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface InsightReportTotal {
  label: string;
  /** Already formatted: `12,345`, or a dash when the app has no number. */
  value: string;
}

export interface InsightReportProps {
  reportName: string;
  workspaceName: string;
  /** The window as the subject shows it: `Nov 1 – Nov 30`. */
  windowLabel: string;
  /** The workspace's own logo, shown above the heading when set. */
  logoUrl: string | null;
  briefText: string | null;
  totals: InsightReportTotal[] | null;
  shareUrl: string | null;
  note: string | null;
}

/** Footer line 1, also used by the sender, which builds the footer itself. */
export function reportFooterReason(workspaceName: string): string {
  return `You get this because ${workspaceName} added you to this report.`;
}

const FIXTURE: InsightReportProps = {
  reportName: 'Monthly review',
  workspaceName: 'Rehman Workspace',
  windowLabel: 'Oct 14 – Nov 12',
  logoUrl: null,
  briefText: 'Reach rose 12% on a quieter month for posting.',
  totals: [
    { label: 'Reach', value: '12,345' },
    { label: 'Engagements', value: '678' },
    { label: 'Followers', value: '9,000' },
    { label: 'Posts', value: '14' },
  ],
  shareUrl: 'http://localhost:3001/r/demo',
  note: 'Thanks all, great month.\nLet us talk Monday.',
};

/**
 * The scheduled Insights report. It is sent by `report-send.service.ts` with
 * its own queue, PDF and one-click unsubscribe, so the footer is built there
 * (spec 4.2: its unsubscribe is the report's own).
 */
export const insightReport = defineTemplate<InsightReportProps>({
  id: 'insight-report',
  category: 'reports',
  event: null,
  footer: 'plain',
  subject: (p) => `${p.reportName}: ${p.windowLabel}`,
  preheader: (p) => `${p.windowLabel} · ${p.workspaceName}`,
  footerReason: (p) => reportFooterReason(p.workspaceName),
  Body: (p) => (
    <>
      {p.logoUrl ? (
        <Img
          src={p.logoUrl}
          alt={p.workspaceName}
          style={{ maxHeight: '48px', maxWidth: '200px', margin: '16px 0 0' }}
        />
      ) : null}
      <Heading>{p.reportName}</Heading>
      <Paragraph tone="muted">{p.windowLabel}</Paragraph>
      {p.briefText ? (
        <>
          <Paragraph tone="muted">In brief</Paragraph>
          <Paragraph>{p.briefText}</Paragraph>
        </>
      ) : null}
      {p.totals ? <DetailRows rows={p.totals} /> : null}
      {p.shareUrl ? (
        <EmailButton href={p.shareUrl} variant="primary">
          Open the report
        </EmailButton>
      ) : null}
      {p.note ? (
        <Text
          style={{
            fontSize: '14px',
            lineHeight: '22px',
            margin: '0 0 16px',
            whiteSpace: 'pre-line',
          }}
        >
          {p.note}
        </Text>
      ) : null}
    </>
  ),
  fixture: FIXTURE,
  variants: {
    minimal: {
      ...FIXTURE,
      briefText: null,
      totals: null,
      shareUrl: null,
      note: null,
    },
    unsafe: {
      ...FIXTURE,
      reportName: '<script>x</script> & "Q4"',
      workspaceName: 'A<b> & Co',
      logoUrl: 'https://cdn.example.com/logo.png',
      briefText: '<i>up</i> & away',
      note: 'a & b <b>',
    },
  },
});
