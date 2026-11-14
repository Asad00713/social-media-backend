/**
 * Email colours. Email clients can't read CSS variables, so the values are
 * inlined from here (spec §4.1). The HTML ships the light design only.
 */
export const EMAIL_COLORS = {
  page: '#F3F4F6',
  card: '#FFFFFF',
  border: '#E5E7EB',
  heading: '#111827',
  body: '#374151',
  muted: '#6B7280',
  primary: '#2563EB',
  onPrimary: '#FFFFFF',
  link: '#2563EB',
  infoBg: '#F3F4F6',
  warnBg: '#FEF3C7',
  dangerBg: '#FEE2E2',
  dangerText: '#B91C1C',
  codeBg: '#F9FAFB',
} as const;

export const EMAIL_FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
