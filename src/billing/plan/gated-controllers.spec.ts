import * as fs from 'fs';
import * as path from 'path';

/**
 * Source-level audit of every controller carrying `@RequiresFeature`.
 *
 * Three things can go wrong when a gate is applied, and none of them fails a
 * build or any ordinary unit test:
 *
 *  1. the decorator is present but `PlanFeatureGuard` is not in `@UseGuards`,
 *     so the metadata is read by nobody and the gate silently does nothing;
 *  2. the guard is listed but the module does not import `BillingModule`, so
 *     the container cannot construct it;
 *  3. the controller's route carries a workspace param spelling the guard does
 *     not resolve, which refuses EVERY request to it — including a paying
 *     customer's.
 *
 * Reading the source is deliberate. Importing the real modules would boot
 * Drizzle and BullMQ and need a database and Redis; what can break without
 * either is the wiring, so the wiring is what this reads.
 */

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const GATED = walk(SRC)
  .map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }))
  .filter((c) => c.src.includes('@RequiresFeature('));

/** The param names `PlanFeatureGuard.canActivate` resolves. */
const RESOLVED_PARAMS = ['workspaceId', 'wsId', 'wid'];

describe('every @RequiresFeature controller is wired to enforce it', () => {
  it('found the gated controllers', () => {
    // A guard against this whole suite passing vacuously: if the glob or the
    // marker ever changes, every test below would trivially pass on an empty
    // list and the audit would be silently gone.
    expect(GATED.length).toBeGreaterThan(5);
  });

  it.each(GATED.map((c) => [path.basename(c.file), c] as const))(
    '%s lists PlanFeatureGuard in @UseGuards',
    (_name, c) => {
      const guards = /@UseGuards\(([^)]*)\)/.exec(c.src)?.[1] ?? '';
      expect(guards).toContain('PlanFeatureGuard');
    },
  );

  it.each(GATED.map((c) => [path.basename(c.file), c] as const))(
    '%s lives in a module that imports BillingModule',
    (_name, c) => {
      // Walk up from the controller to the nearest *.module.ts, which is how
      // this repo lays modules out (one per feature directory).
      let dir = path.dirname(c.file);
      let moduleSrc: string | null = null;
      for (let i = 0; i < 4 && !moduleSrc; i++) {
        const hit = fs
          .readdirSync(dir)
          .find((f) => f.endsWith('.module.ts') && !f.endsWith('.spec.ts'));
        if (hit) moduleSrc = fs.readFileSync(path.join(dir, hit), 'utf8');
        else dir = path.dirname(dir);
      }
      expect(moduleSrc).not.toBeNull();
      // Must appear in the `imports:` array, not merely as an `import`
      // statement at the top: a leftover import line with the module dropped
      // from the array compiles, and the guard then cannot be constructed.
      const src = moduleSrc as string;
      const from = src.indexOf('imports: [');
      expect(from).toBeGreaterThan(-1);
      // Comment lines are stripped first. The modules wired here carry a
      // comment that mentions BillingModule by name, and without this the
      // assertion matched that prose instead of the array entry: it passed
      // with the module actually removed from the imports array.
      const importsBlock = src
        .slice(from, src.indexOf('],', from))
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      expect(importsBlock).toContain('BillingModule');
    },
  );

  it.each(GATED.map((c) => [path.basename(c.file), c] as const))(
    '%s exposes a workspace param the guard can resolve',
    (_name, c) => {
      // Every param this controller declares, from @Controller and @Get/@Post
      // paths alike — a route-level `workspaces/:workspaceId/...` counts, so
      // the class prefix need not carry it.
      const params = [...c.src.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(
        (m) => m[1],
      );
      expect(params.some((p) => RESOLVED_PARAMS.includes(p))).toBe(true);
    },
  );
});
