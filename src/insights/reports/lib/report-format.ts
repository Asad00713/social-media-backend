const MAX_SLUG_CHARS = 60;

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const dayLabel = (date: string): string =>
  DAY_FORMAT.format(new Date(`${date}T00:00:00Z`));

/** `2026-11-01`, `2026-11-30` → `Nov 1 – Nov 30` (an en dash, spaced). Expects date-only `YYYY-MM-DD` strings. */
export function windowLabel(from: string, to: string): string {
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}

/**
 * A report name as a file-name part: lowercase letters and digits, one dash
 * between runs of anything else, at most 60 characters, `report` when nothing
 * is left.
 */
export function reportSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, '');
  return slug || 'report';
}

/** `acme-report-2026-11-01-2026-11-30.pdf` */
export function pdfFilename(
  name: string,
  window: { from: string; to: string },
): string {
  return `${reportSlug(name)}-${window.from}-${window.to}.pdf`;
}
