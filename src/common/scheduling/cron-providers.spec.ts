import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Every class that declares a `@Cron` must be provided by some module.
 *
 * ## The bug this exists for
 *
 * `WorkspacePurgeService` declared `@Cron('40 3 * * *', { name:
 * 'workspacePurge' })` and was in no module's `providers`. Nest therefore
 * never instantiated it, its cron never registered, and **soft-deleted
 * workspaces were never hard-deleted** — the 30-day purge simply did not run.
 *
 * Nothing failed. The class compiled, its own unit tests passed (they call
 * `new WorkspacePurgeService().purge()` directly), and the only visible trace
 * was that production registered 27 crons while the source declared 28.
 *
 * A count cannot catch this and neither can a unit test that constructs the
 * service by hand. This walks the source instead: find every `@Cron`, then
 * require its class to appear in some `providers` array.
 */
const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);

/** Classes that declare at least one @Cron. */
function cronClasses(): { cls: string; file: string }[] {
  const found: { cls: string; file: string }[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/@Cron\(/.test(src)) continue;
    for (const m of src.matchAll(/export class (\w+)/g)) {
      // Only count the class if a @Cron appears after its declaration.
      const after = src.slice(m.index ?? 0);
      if (/@Cron\(/.test(after)) found.push({ cls: m[1], file: f });
    }
  }
  return found;
}

/**
 * Every identifier a module could be providing.
 *
 * Deliberately generous, because a false ACCUSATION here is worse than a
 * miss: it would make someone 'fix' a service that is already wired.
 *
 * Two real shapes this has to allow, both found by running it:
 *  - a `providers: [...]` array containing nested brackets, so matching
 *    lazily up to the first `]` truncates it (ReportsScheduler sat past
 *    the cut and was reported missing while being correctly provided);
 *  - providers collected in a plain `*.providers.ts` file and spread into
 *    a module (LaterWakeService is registered that way).
 *
 * So: scan every non-spec source file, not just `*.module.ts`, and take
 * identifiers from the whole file rather than from a bracket-matched
 * slice. A class named in an import alone is not enough to pass -- it has
 * to appear in a file that actually declares providers.
 */
function providedNames(): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/providers:\s*\[/.test(src) && !/\.providers\.ts$/.test(f)) {
      continue;
    }
    const body = src.replace(/^import[\s\S]*?;$/gm, '');
    for (const id of body.matchAll(/([A-Z]\w+)/g)) names.add(id[1]);
  }
  return names;
}

describe('every @Cron class is provided by a module', () => {
  const classes = cronClasses();
  const provided = providedNames();

  it('finds the cron-declaring classes at all', () => {
    // Guards the net itself: a regex that matches nothing would pass silently.
    expect(classes.length).toBeGreaterThan(20);
    expect(provided.size).toBeGreaterThan(50);
  });

  it.each(classes.map((c) => [c.cls]))(
    '%s appears in some module providers[]',
    (cls) => {
      expect(provided.has(cls as string)).toBe(true);
    },
  );
});
