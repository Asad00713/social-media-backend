import type { InsightsOverviewDto } from '../../dto/insights.dto';
import type { Brief } from '../../lib/brief';
import type { AppLinks } from '../../../email/links/app-links';
import { renderEmail } from '../../../email/render/render-email';
import {
  insightReport,
  reportFooterReason,
  type InsightReportProps,
} from '../../../email/templates/reports/insight-report';
import { windowLabel } from './report-format';

export interface ReportEmailInput {
  reportName: string;
  workspaceName: string;
  window: { from: string; to: string };
  logoUrl: string | null;
  briefText: string | null;
  totals: {
    reach: number | null;
    engagements: number | null;
    followers: number | null;
    posts: number | null;
  } | null;
  shareUrl: string | null;
  note: string | null;
  unsubscribeUrl: string;
}

export interface ReportEmail {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** What a total reads as when the app has no number for it. */
const NO_VALUE = '—';

type Totals = NonNullable<ReportEmailInput['totals']>;

const TOTAL_LABELS: [keyof Totals, string][] = [
  ['reach', 'Reach'],
  ['engagements', 'Engagements'],
  ['followers', 'Followers'],
  ['posts', 'Posts'],
];

const formatTotal = (value: number | null): string =>
  value === null ? NO_VALUE : value.toLocaleString('en-US');

/** The In brief sentence of an overview, as plain text. */
export function briefTextOf(brief: Brief): string {
  return brief.status === 'ready'
    ? brief.segments.map((segment) => segment.text).join('')
    : brief.text;
}

/** The four numbers the email shows, straight from the overview's KPIs. */
export function totalsOf(kpis: InsightsOverviewDto['kpis']): Totals {
  return {
    reach: kpis.reach.value,
    engagements: kpis.engagements.value,
    followers: kpis.followers.value,
    posts: kpis.postsPublished.value,
  };
}

/** What a report email needs from the app's links: images, help and privacy. */
export type ReportEmailLinks = Pick<AppLinks, 'assetBase' | 'help' | 'privacy'>;

/**
 * The scheduled report email: the report's name, its window, the In brief
 * line, four totals and a button to the live report, in the shared email
 * layout. The PDF rides along as an attachment, added by the caller. Its
 * footer is the report's own: why you got it, and its one-click unsubscribe.
 */
export async function reportEmail(
  i: ReportEmailInput,
  links: ReportEmailLinks,
): Promise<ReportEmail> {
  const { totals } = i;
  const props: InsightReportProps = {
    reportName: i.reportName,
    workspaceName: i.workspaceName,
    windowLabel: windowLabel(i.window.from, i.window.to),
    logoUrl: i.logoUrl,
    // Typed by a person: blank counts as not written.
    briefText: i.briefText?.trim() || null,
    totals: totals
      ? TOTAL_LABELS.map(([key, label]) => ({
          label,
          value: formatTotal(totals[key]),
        }))
      : null,
    shareUrl: i.shareUrl,
    note: i.note?.trim() || null,
  };
  const rendered = await renderEmail(insightReport, props, {
    assetBaseUrl: links.assetBase(),
    footer: {
      reason: reportFooterReason(i.workspaceName),
      links: [
        { label: 'Stop receiving this report', href: i.unsubscribeUrl },
        { label: 'Help center', href: links.help() },
        { label: 'Privacy', href: links.privacy() },
      ],
    },
  });
  return {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      'List-Unsubscribe': `<${i.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
