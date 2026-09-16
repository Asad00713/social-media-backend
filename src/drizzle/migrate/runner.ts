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

/** Thrown when a migration file cannot be executed safely. */
export class UnsafeMigrationError extends Error {}

/** Files deliberately never run by the runner. */
export function isExcluded(name: string): boolean {
  // `.PROD-SAFE.sql` variants are hand-run alternatives to a committed
  // migration that is unsafe on production (0030 deletes billing tables).
  // Running both would apply the same structural change twice.
  // Case-insensitive, and tolerant of `-` vs `_`: this marker is the only thing
  // standing between a hand-run alternative and the automatic execution of the
  // destructive migration it replaces, so near-misses must still exclude.
  return /\.prod[-_]safe\./i.test(name);
}

export function checksumOf(sql: string): string {
  // Normalise line endings first: this repo is checked out on Windows, where
  // git converts LF to CRLF, and that must not read as an edited migration.
  return createHash('sha256')
    .update(sql.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

/**
 * Blank out comments, dollar-quoted blocks and string literals, keeping offsets.
 *
 * Used only to find transaction-control keywords in executable SQL. A `BEGIN`
 * opening a `DO $$ ... $$` block is PL/pgSQL, not a transaction, and the word
 * "commit" appears in prose comments in these migrations. Replacing with spaces
 * rather than deleting keeps indices aligned with the original string.
 */
function blankNonSql(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? sql.length : close + tag.length;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Every transaction-control statement in executable SQL, with its offset.
 *
 * The statement is matched from its keyword all the way to the terminating
 * semicolon, NOT just `KEYWORD;`. Postgres accepts a tail on most of these —
 * `COMMIT AND CHAIN;`, `BEGIN ISOLATION LEVEL SERIALIZABLE;`, `ROLLBACK TO
 * SAVEPOINT s;` — and an earlier version that required the semicolon directly
 * after the keyword missed every one of them. `COMMIT AND CHAIN;` is the worst:
 * it commits and immediately opens a new transaction, so the runner's own
 * transaction ends mid-file and everything before it is applied for good, while
 * the applied-record rolls back with the remainder. The file then runs again on
 * the next boot, half-applied.
 */
export function findTransactionControl(
  sql: string,
): { keyword: string; index: number }[] {
  const scannable = blankNonSql(sql);
  // `END` is deliberately absent: `END;` closes a PL/pgSQL block far more often
  // than it ends a transaction here, and a DO block's body is already blanked,
  // so a bare `END;` in real SQL is vanishingly rare. `ABORT` and `PREPARE
  // TRANSACTION` are present — ABORT is safe in effect but must not pass
  // silently, and PREPARE TRANSACTION would strand a prepared transaction.
  const re =
    /\b(?:BEGIN|START[ \t]+TRANSACTION|COMMIT|ROLLBACK|ABORT|PREPARE[ \t]+TRANSACTION|SAVEPOINT|RELEASE[ \t]+SAVEPOINT)\b[^;]*;/gi;
  const found: { keyword: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scannable)) !== null) {
    found.push({ keyword: m[0].trim(), index: m.index });
  }
  return found;
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
 * Only the common shape is rewritten: exactly one leading `BEGIN;` and one
 * trailing `COMMIT;` wrapping the whole file. Anything else — a second pair, a
 * stray COMMIT, `BEGIN TRANSACTION;` — is left alone here and REJECTED by
 * `readMigrations`. An earlier version matched more loosely and could leave a
 * stray `COMMIT;` mid-body, which silently ends the runner's transaction:
 * everything before it commits for good, a later failure rolls back only the
 * tail, and the applied-record is lost, so the half-applied file runs again on
 * the next boot. Rejecting beats rewriting — it turns data loss into a startup
 * error.
 */
export function stripOuterTransaction(sql: string): string {
  const control = findTransactionControl(sql);
  if (control.length !== 2) return sql;

  const [first, last] = control;
  // Only comments and whitespace may sit outside the wrapper. Every migration
  // here opens with an explanatory comment block, so blanking comments (rather
  // than a bare trim) is what lets the common shape still be recognised.
  const outsideIsInert = (text: string): boolean =>
    blankNonSql(text).trim().length === 0;

  // Exactly `BEGIN;` and `COMMIT;` — a variant with a tail (`COMMIT AND CHAIN;`,
  // `BEGIN ISOLATION LEVEL ...`) is never stripped, so it falls through to the
  // rejection in readMigrations instead of being quietly removed.
  const wrapsWholeFile =
    /^BEGIN[ \t]*;$/i.test(first.keyword) &&
    /^COMMIT[ \t]*;$/i.test(last.keyword) &&
    outsideIsInert(sql.slice(0, first.index)) &&
    outsideIsInert(sql.slice(last.index + last.keyword.length));

  if (!wrapsWholeFile) return sql;

  return (
    sql.slice(0, first.index) +
    sql.slice(first.index + first.keyword.length, last.index) +
    sql.slice(last.index + last.keyword.length)
  );
}

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !isExcluded(f))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      const sql = stripOuterTransaction(raw);

      // What we execute must contain NO transaction control of its own. A stray
      // COMMIT would end the runner's transaction early and break the atomicity
      // this whole design rests on. Refuse to start rather than half-apply.
      const leftover = findTransactionControl(sql);
      if (leftover.length > 0) {
        throw new UnsafeMigrationError(
          `${name}: contains transaction control the runner cannot own (` +
            leftover.map((c) => c.keyword).join(', ') +
            '). Each migration runs inside one transaction opened by the ' +
            'runner, so a file may either wrap itself in a single leading ' +
            'BEGIN; and trailing COMMIT;, or use none at all. A DO block is ' +
            'fine — its BEGIN is PL/pgSQL, not a transaction.',
        );
      }

      return { name, sql, checksum: checksumOf(raw) };
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
