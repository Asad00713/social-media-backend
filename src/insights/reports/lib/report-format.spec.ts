import { pdfFilename, reportSlug, windowLabel } from './report-format';

describe('windowLabel', () => {
  it('writes a window in one month as "Nov 1 – Nov 30"', () => {
    expect(windowLabel('2026-11-01', '2026-11-30')).toBe('Nov 1 – Nov 30');
  });

  it('writes a window across months', () => {
    expect(windowLabel('2026-10-15', '2026-11-14')).toBe('Oct 15 – Nov 14');
  });

  it('writes a window across a year end without drifting a day', () => {
    expect(windowLabel('2026-12-20', '2027-01-02')).toBe('Dec 20 – Jan 2');
  });

  it('writes a one-day window', () => {
    expect(windowLabel('2026-03-08', '2026-03-08')).toBe('Mar 8 – Mar 8');
  });
});

describe('reportSlug', () => {
  it('lowercases and joins words with a dash', () => {
    expect(reportSlug('Acme Monthly Report')).toBe('acme-monthly-report');
  });

  it('turns a run of other characters into one dash and trims the ends', () => {
    expect(reportSlug('  --Acme & Co. (Q4)!!  ')).toBe('acme-co-q4');
  });

  it('keeps digits', () => {
    expect(reportSlug('Q4 2026')).toBe('q4-2026');
  });

  it('falls back to "report" when nothing is left', () => {
    expect(reportSlug('')).toBe('report');
    expect(reportSlug('  ---  ')).toBe('report');
    expect(reportSlug('日本語')).toBe('report');
  });

  it('cuts at 60 characters', () => {
    const slug = reportSlug('a'.repeat(100));
    expect(slug).toHaveLength(60);
    expect(slug).toBe('a'.repeat(60));
  });

  it('does not end on a dash after the cut', () => {
    const name = `${'a'.repeat(59)} bbb`;
    expect(reportSlug(name)).toBe('a'.repeat(59));
  });
});

describe('pdfFilename', () => {
  it('is the slug and the window dates', () => {
    expect(
      pdfFilename('Acme Report', { from: '2026-11-01', to: '2026-11-30' }),
    ).toBe('acme-report-2026-11-01-2026-11-30.pdf');
  });

  it('uses the fallback slug for an empty name', () => {
    expect(pdfFilename('', { from: '2026-12-20', to: '2027-01-02' })).toBe(
      'report-2026-12-20-2027-01-02.pdf',
    );
  });
});
