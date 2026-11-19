import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINKEDIN_REST_VERSION,
  LINKEDIN_VERSION_HEADER,
} from './linkedin-version';

/**
 * One LinkedIn version pin, for the whole codebase.
 *
 * LinkedIn requires the `Linkedin-Version` header on every `/rest` call (the
 * latest is NOT applied by default) and sunsets each monthly version after
 * about a year. A pinned version is therefore a thing that **expires**, and a
 * pin written down twice expires in one place first.
 *
 * That has happened twice here. The second time, the analytics adapter sat on
 * `202402` for about two and a half years while publishing moved to `202610`:
 * LinkedIn answered every analytics call with HTTP 426 — *"Requested version
 * 20240201 is not active"* — so **LinkedIn analytics silently returned nothing
 * while LinkedIn publishing worked**, at 12,473 error rows in seven days.
 *
 * So this is written fail-CLOSED, over the source tree rather than over a list
 * of files somebody remembers to update. The same shape as BE #251 / #252,
 * where what was missing was a line, not a wrong one.
 */

const CHANNELS_DIR = join(__dirname, '..');

/** Every non-spec .ts file under src/channels. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that send the version header.
 *
 * Matches **either** the literal header name (in either casing) **or**
 * `LINKEDIN_VERSION_HEADER`. The second half is not optional: the analytics
 * client now writes `headers[LINKEDIN_VERSION_HEADER] = ...`, so the literal
 * string no longer appears in it at all. A net that looked only for the
 * literal found one file instead of two and reported success — it would have
 * stopped policing the very file whose drift caused this.
 */
function filesSendingTheHeader(): Array<{ path: string; text: string }> {
  return sourceFiles(CHANNELS_DIR)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(
      ({ path, text }) =>
        !path.endsWith(join('lib', 'linkedin-version.ts')) &&
        (/inked[Ii]n-Version/.test(text) ||
          /LINKEDIN_VERSION_HEADER/.test(text)),
    );
}

describe('the pin itself', () => {
  it('is a YYYYMM month LinkedIn would recognise', () => {
    expect(LINKEDIN_REST_VERSION).toMatch(/^\d{6}$/);
    const year = Number(LINKEDIN_REST_VERSION.slice(0, 4));
    const month = Number(LINKEDIN_REST_VERSION.slice(4));
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(year).toBeGreaterThanOrEqual(2024);
  });

  /**
   * The failure this file exists for, stated as a rule rather than as a date:
   * LinkedIn supports a version for "a minimum of one year", so a pin more
   * than a year behind is one LinkedIn may already have sunset. `202402` was
   * about 2.5 years stale when it was found, and nothing failed except the
   * API calls themselves.
   */
  it('is not already old enough to have been sunset', () => {
    const pinned =
      Number(LINKEDIN_REST_VERSION.slice(0, 4)) * 12 +
      Number(LINKEDIN_REST_VERSION.slice(4));
    const now = new Date();
    const current = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
    const monthsBehind = current - pinned;

    expect({ LINKEDIN_REST_VERSION, monthsBehind }).toEqual({
      LINKEDIN_REST_VERSION,
      monthsBehind: expect.any(Number),
    });
    // Twelve months is LinkedIn's stated minimum support window. Failing at
    // 11 leaves a month to read the changelog and bump deliberately, rather
    // than discovering it from a 426 in production.
    expect(monthsBehind).toBeLessThanOrEqual(11);
  });

  it('uses LinkedIn’s own spelling of the header', () => {
    // Case-insensitive per RFC 9110, and LinkedIn accepts both — the analytics
    // adapter sent `LinkedIn-Version` for years and its only problem was the
    // stale value. Unified anyway so one grep finds every sender, which is
    // precisely what did not happen last time.
    expect(LINKEDIN_VERSION_HEADER).toBe('Linkedin-Version');
  });
});

describe('every sender uses the shared pin', () => {
  const senders = filesSendingTheHeader();

  it('finds the files it is meant to police', () => {
    // Pinned so a renamed or moved client shows up here rather than silently
    // shrinking the net. Two today: the analytics client and the publishing
    // service.
    expect(senders.length).toBeGreaterThanOrEqual(2);
  });

  it.each(filesSendingTheHeader().map((f) => [f.path, f.text]))(
    '%s sends no hard-coded version',
    (_path, text) => {
      // A literal YYYYMM next to the header is the exact shape of both past
      // failures: `'LinkedIn-Version': '202402'` and `'202404'`.
      const literals = [
        ...(text as string).matchAll(
          /inked[Ii]n-Version['"]?\s*\]?\s*[:=]\s*['"](\d{6})['"]/g,
        ),
      ].map((m) => m[1]);

      expect({ literals }).toEqual({ literals: [] });
    },
  );

  it.each(filesSendingTheHeader().map((f) => [f.path, f.text]))(
    '%s references LINKEDIN_REST_VERSION',
    (_path, text) => {
      expect(text as string).toMatch(/LINKEDIN_REST_VERSION/);
    },
  );
});
