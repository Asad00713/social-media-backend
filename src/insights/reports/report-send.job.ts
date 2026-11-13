/**
 * The `reports` queue's job. Kept apart from ReportSendService so
 * ReportsService (which enqueues it) and ReportSendService (which calls
 * ReportsService.pdfFor) do not import each other.
 */
export interface ReportSendJob {
  reportId: string;
  /** `scheduled` moves the slot on; `now` is a Send now and leaves it. */
  kind: 'scheduled' | 'now';
  /** Addresses already emailed, so a retry sends only to the rest. */
  sent?: string[];
}

export const REPORT_SEND_JOB = 'report-send';
