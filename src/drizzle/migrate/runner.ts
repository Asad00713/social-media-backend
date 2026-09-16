import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration file on disk.
 *
 * `name` is the filename, which is also the identity recorded as applied.
 * Files run in filename order, which is why every migration is numbered.
 */
export interface MigrationFile {
  name: string;
  /** SQL as it will be executed — the file's own transaction wrapper removed. */
  sql: string;
  /** Checksum of the file as committed, so identity is independent of that. */
  checksum: string;
}

export interface AppliedRow {
  name: string;
  checksum: string;
}

/** Files deliberately never run by the runner. */
export function isExcluded(name: string): boolean {
  // `.PROD-SAFE.sql` variants are hand-run alternatives to a committed
  // migration that is unsafe on production (0030 deletes billing tables).
  // Running both would apply the same structural change twice.
  return name.includes('.PROD-SAFE.');
}

export function checksumOf(sql: string): string {
  // Normalise line endings first: this repo is checked out on Windows, where
  // git converts LF to CRLF, and that must not read as an edited migration.
  return createHash('sha256')
    .update(sql.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

/**
 * Remove a file's own outermost BEGIN/COMMIT so the runner owns the transaction.
 *
 * This is for correctness, not tidiness: the row recording a migration as
 * applied must commit atomically WITH that migration. If the file drove its own
 * transaction, that record would land outside it, and a crash in the gap would
 * leave the migration applied but unrecorded — so it would run again. `0030`
 * drops a column; a second run is not survivable.
 *
 * Only a leading `BEGIN;` and a trailing `COMMIT;` are removed. A `BEGIN`
 * opening a `DO $$` block is PL/pgSQL, not a transaction, and carries no
 * semicolon — the anchors below leave it alone.
 */
export function stripOuterTransaction(sql: string): string {
  const leading = /^((?:[ \t]*--[^\n]*\n|\s*)*?)BEGIN[ \t]*;/i;
  const withoutBegin = sql.replace(leading, '$1');
  const trailing = /COMMIT[ \t]*;((?:\s|--[^\n]*)*)$/i;
  return withoutBegin.replace(trailing, '$1');
}

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !isExcluded(f))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      return {
        name,
        sql: stripOuterTransaction(raw),
        checksum: checksumOf(raw),
      };
    });
}

/**
 * Decide what to run, and refuse everything if an applied file was edited.
 *
 * An edited migration means the database no longer matches the file that
 * produced it. Continuing would stack later migrations on a schema nobody can
 * reproduce, so this is a hard stop rather than a warning.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedRow[],
): { pending: MigrationFile[]; drifted: string[] } {
  const byName = new Map(applied.map((r) => [r.name, r.checksum]));
  const drifted: string[] = [];
  const pending: MigrationFile[] = [];

  for (const file of files) {
    const seen = byName.get(file.name);
    if (seen === undefined) {
      pending.push(file);
    } else if (seen !== file.checksum) {
      drifted.push(file.name);
    }
  }

  return { pending, drifted };
}
