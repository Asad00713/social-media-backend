import type { InsightsOverviewDto } from '../../dto/insights.dto';
import type { Brief } from '../../lib/brief';
import { escapeHtml } from './escape-html';
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

const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

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

function totalsHtml(totals: Totals): string {
  const cells = TOTAL_LABELS.map(
    ([key, label]) =>
      `<td width="25%" style="padding:12px 8px;text-align:center;border:1px solid #e5e7eb;">` +
      `<div style="font-size:12px;color:#6b7280;">${label}</div>` +
      `<div style="font-size:20px;font-weight:600;color:#111827;">${formatTotal(totals[key])}</div>` +
      `</td>`,
  ).join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">` +
    `<tr>${cells}</tr></table>`
  );
}

/**
 * The scheduled report email: the report's name, its window, the In brief
 * line, four totals and a button to the live report. The PDF rides along as
 * an attachment, added by the caller. Inline styles only, as mail clients
 * strip the rest.
 */
export function reportEmail(i: ReportEmailInput): ReportEmail {
  const { totals } = i;
  // Typed by a person: blank counts as not written.
  const briefText = i.briefText?.trim() || null;
  const note = i.note?.trim() || null;
  const label = windowLabel(i.window.from, i.window.to);
  const subject = `${i.reportName}: ${label}`;
  const footer = `You get this because ${i.workspaceName} added you to this report.`;
  const unsubscribeLabel = 'Stop receiving this report';
  const buttonLabel = 'Open the report';

  const html = [
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:${FONT};">`,
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:32px;border-radius:8px;">`,
    i.logoUrl
      ? `<img src="${escapeHtml(i.logoUrl)}" alt="${escapeHtml(i.workspaceName)}" style="display:block;max-height:48px;max-width:200px;margin:0 0 20px;">`
      : '',
    `<h1 style="margin:0 0 4px;font-size:22px;color:#111827;">${escapeHtml(i.reportName)}</h1>`,
    `<p style="margin:0 0 20px;font-size:14px;color:#6b7280;">${escapeHtml(label)}</p>`,
    briefText
      ? `<p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;">In brief</p>` +
        `<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#111827;">${escapeHtml(briefText)}</p>`
      : '',
    totals ? totalsHtml(totals) : '',
    i.shareUrl
      ? `<p style="margin:0 0 20px;"><a href="${escapeHtml(i.shareUrl)}" style="display:inline-block;padding:10px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">${buttonLabel}</a></p>`
      : '',
    note
      ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#374151;white-space:pre-line;">${escapeHtml(note)}</p>`
      : '',
    `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0 16px;">`,
    `<p style="margin:0 0 8px;font-size:12px;color:#6b7280;">${escapeHtml(footer)}</p>`,
    `<p style="margin:0;font-size:12px;"><a href="${escapeHtml(i.unsubscribeUrl)}" style="color:#6b7280;">${unsubscribeLabel}</a></p>`,
    `</div></body></html>`,
  ].join('');

  const text = [
    i.reportName,
    label,
    briefText ? `In brief: ${briefText}` : null,
    totals
      ? TOTAL_LABELS.map(
          ([key, name]) => `${name}: ${formatTotal(totals[key])}`,
        ).join('\n')
      : null,
    i.shareUrl ? `${buttonLabel}: ${i.shareUrl}` : null,
    note,
    `---\n${footer}\n${unsubscribeLabel}: ${i.unsubscribeUrl}`,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join('\n\n');

  return {
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${i.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
