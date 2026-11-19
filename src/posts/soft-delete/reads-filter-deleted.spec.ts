import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { READS_EXEMPT_FROM_DELETED_FILTER } from './reads-exempt-from-deleted-filter';

/**
 * The regression net for soft delete.
 *
 * Soft delete only works if *every* read excludes the deleted rows. There are
 * ~37 files reading `posts`, plus raw SQL, and one missed filter means a post
 * the author deleted reappears in their Planner — the exact bug soft delete is
 * supposed to prevent, dressed as a feature.
 *
 * Rather than trusting a one-time sweep, this discovers the read sites from
 * disk on every run, so a read written next month is covered without anyone
 * remembering this file exists. The only way past it is an entry in
 * READS_EXEMPT_FROM_DELETED_FILTER, which demands a reason.
 *
 * Modelled on every-workspace-route-guarded.spec.ts, which does the same for
 * route guards.
 */

const SRC = join(__dirname, '..', '..');
const REPO = join(SRC, '..');

/**
 * Covers both tables. `workspace` shipped first and `posts` followed, and
 * widening these patterns was the whole change on this side — the read sites
 * are discovered from disk rather than listed, so neither half needed a new
 * inventory.
 */
const BUILDER_READ = /\.from\(\s*(?:posts|workspace)\s*\)/;

/**
 * Drizzle's relational API — `db.query.workspace.findFirst/findMany`. A
 * different spelling of the same read, and one `.from(workspace)` does not
 * see: 34 of these were invisible to the first version of this file.
 */
const RELATIONAL_READ = /\.query\.(?:posts|workspace)\.find/;

/**
 * Raw SQL. Deliberately anchored to a `${sql}` template or a quoted query
 * rather than matching the words anywhere: "removed from workspace" in a log
 * line or an email subject is not a read, and three files were flagged for
 * exactly that. `workspace_usage` and friends must not match either, hence
 * the word boundary that excludes a following underscore.
 */
const RAW_READ = /\b(?:FROM|JOIN)\s+(?:posts|workspace)(?![_a-z])/;

/** Evidence the file excludes deleted rows somehow. */
const FILTERS = [
  /liveWorkspaces\(\)/,
  /livePosts\(\)/,
  /livePostsSql\(/,
  // The relational API takes a callback: `where: (w, { isNull }) => ...`
  /isNull\(\s*\w+\.deletedAt\s*\)/,
  /liveWorkspacesSql\(/,
  /isNull\(\s*workspace\.deletedAt\s*\)/,
  /deleted_at\s+IS\s+NULL/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

interface ReadSite {
  key: string;
  filters: boolean;
}

function collectReadSites(): ReadSite[] {
  return walk(SRC)
    .map((file) => ({ file, body: readFileSync(file, 'utf8') }))
    .filter(
      ({ body }) =>
        BUILDER_READ.test(body) ||
        RAW_READ.test(body) ||
        RELATIONAL_READ.test(body),
    )
    .map(({ file, body }) => ({
      // Posix-style, so the exemption keys read the same on every machine.
      key: relative(REPO, file).split(sep).join('/'),
      filters: FILTERS.some((pattern) => pattern.test(body)),
    }));
}

describe('every read of posts or workspace excludes soft-deleted rows', () => {
  const sites = collectReadSites();

  it('discovers a plausible number of read sites', () => {
    // If this ever collapses to a handful, the detection broke and the rest
    // of this file is passing on an empty set.
    expect(sites.length).toBeGreaterThan(20);
  });

  it('every read either filters deleted rows or is exempt with a reason', () => {
    const offenders = sites
      .filter((site) => !(site.key in READS_EXEMPT_FROM_DELETED_FILTER))
      .filter((site) => !site.filters)
      .map((site) => site.key);

    expect(offenders).toEqual([]);
  });

  it('the exemption list has no stale entries', () => {
    const real = new Set(sites.map((s) => s.key));
    const stale = Object.keys(READS_EXEMPT_FROM_DELETED_FILTER).filter(
      (key) => !real.has(key),
    );
    expect(stale).toEqual([]);
  });

  it('every exemption states a reason', () => {
    for (const [key, reason] of Object.entries(
      READS_EXEMPT_FROM_DELETED_FILTER,
    )) {
      expect({ key, ok: reason.trim().length > 15 }).toEqual({ key, ok: true });
    }
  });
});
