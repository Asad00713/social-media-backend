import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsafeMigrationError,
  checksumOf,
  findTransactionControl,
  isExcluded,
  planMigrations,
  readMigrations,
  stripOuterTransaction,
  type AppliedRow,
  type MigrationFile,
} from './runner';

/** Write one migration file into a fresh temp dir; returns a read thunk. */
function readOne(name: string, sql: string): () => MigrationFile[] {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(join(dir, name), sql, 'utf8');
  return () => readMigrations(dir);
}

function file(name: string, sql = 'SELECT 1;'): MigrationFile {
  return { name, sql, checksum: checksumOf(sql) };
}

describe('isExcluded', () => {
  it('excludes .PROD-SAFE. variants, which are hand-run alternatives', () => {
    expect(isExcluded('0030_billing_account_scope.PROD-SAFE.sql')).toBe(true);
  });

  it('does not exclude ordinary migrations', () => {
    expect(isExcluded('0030_billing_account_scope.sql')).toBe(false);
    expect(isExcluded('0035_error_logs.sql')).toBe(false);
  });
});

describe('checksumOf', () => {
  it('ignores CRLF-vs-LF so a Windows checkout is not seen as drift', () => {
    expect(checksumOf('BEGIN;\r\nSELECT 1;\r\n')).toBe(
      checksumOf('BEGIN;\nSELECT 1;\n'),
    );
  });

  it('still changes when the SQL genuinely changes', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});

describe('stripOuterTransaction', () => {
  it('removes a leading BEGIN and trailing COMMIT', () => {
    const out = stripOuterTransaction('BEGIN;\nALTER TABLE t ADD c int;\nCOMMIT;\n');
    expect(out).not.toMatch(/BEGIN/i);
    expect(out).not.toMatch(/COMMIT/i);
    expect(out).toContain('ALTER TABLE t ADD c int;');
  });

  it('removes BEGIN even when comments precede it', () => {
    const out = stripOuterTransaction('-- why\n-- more\nBEGIN;\nSELECT 1;\nCOMMIT;');
    expect(out).not.toMatch(/BEGIN\s*;/i);
    expect(out).toContain('-- why');
  });

  it('leaves a file without its own transaction untouched', () => {
    const sql = 'CREATE TABLE t (id int);\n';
    expect(stripOuterTransaction(sql)).toBe(sql);
  });

  it('does NOT strip BEGIN/END inside a DO $$ block — that is PL/pgSQL', () => {
    const sql = [
      'DO $$',
      'DECLARE n integer;',
      'BEGIN',
      '  SELECT count(*) INTO n FROM t;',
      "  IF n > 0 THEN RAISE EXCEPTION 'no'; END IF;",
      'END $$;',
      '',
    ].join('\n');
    // The DO block's BEGIN has no semicolon and is not at the statement start,
    // so it must survive: stripping it would corrupt the block.
    expect(stripOuterTransaction(sql)).toContain('BEGIN');
    expect(stripOuterTransaction(sql)).toContain('END $$;');
  });

  it('strips the wrapper but keeps a DO block when both are present', () => {
    const sql = [
      'BEGIN;',
      'DO $$',
      'BEGIN',
      "  RAISE EXCEPTION 'x';",
      'END $$;',
      'COMMIT;',
    ].join('\n');
    const out = stripOuterTransaction(sql);
    expect(out).not.toMatch(/^\s*BEGIN\s*;/i);
    expect(out).not.toMatch(/COMMIT\s*;\s*$/i);
    expect(out).toContain('DO $$');
    expect(out).toContain('END $$;');
  });
});

describe('planMigrations', () => {
  it('treats unrecorded files as pending, in order', () => {
    const files = [file('0001_a.sql'), file('0002_b.sql')];
    const { pending, drifted } = planMigrations(files, []);
    expect(pending.map((f) => f.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(drifted).toEqual([]);
  });

  it('skips files already recorded — the whole point of baselining prod', () => {
    const a = file('0001_a.sql');
    const b = file('0002_b.sql');
    const applied: AppliedRow[] = [{ name: a.name, checksum: a.checksum }];
    const { pending } = planMigrations([a, b], applied);
    expect(pending.map((f) => f.name)).toEqual(['0002_b.sql']);
  });

  it('reports drift when an applied migration was edited, and does not queue it', () => {
    const a = file('0001_a.sql', 'SELECT 1;');
    const applied: AppliedRow[] = [{ name: a.name, checksum: checksumOf('SELECT 999;') }];
    const { pending, drifted } = planMigrations([a], applied);
    expect(drifted).toEqual(['0001_a.sql']);
    expect(pending).toEqual([]);
  });

  it('reports nothing pending when everything is recorded', () => {
    const a = file('0001_a.sql');
    const { pending, drifted } = planMigrations([a], [
      { name: a.name, checksum: a.checksum },
    ]);
    expect(pending).toEqual([]);
    expect(drifted).toEqual([]);
  });
});

describe('transaction-control safety (regressions from review)', () => {
  // The executed SQL must never contain transaction control of its own. A stray
  // COMMIT ends the runner's transaction early: everything before it commits
  // permanently, a later failure rolls back only the tail, and the applied-row
  // is lost — so the half-applied file runs again on the next boot.
  const executedIsClean = (sql: string) =>
    findTransactionControl(stripOuterTransaction(sql)).length === 0;

  it('rejects a file with TWO BEGIN/COMMIT pairs instead of mangling it', () => {
    const sql =
      'BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;\n\n' +
      'BEGIN;\nCREATE TABLE b (id int);\nCOMMIT;\n';
    expect(executedIsClean(sql)).toBe(false);
    expect(readOne('0900_two_pairs.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('strips through a trailing block comment — a comment is inert', () => {
    const sql = 'BEGIN;\nCREATE TABLE c (id int);\nCOMMIT;\n/* done */\n';
    expect(executedIsClean(sql)).toBe(true);
    const [file] = readOne('0901_trailing_block.sql', sql)();
    expect(file.sql).not.toMatch(/\bCOMMIT\b/i);
    expect(file.sql).toContain('CREATE TABLE c (id int);');
  });

  it('rejects BEGIN TRANSACTION; — an unbalanced open transaction', () => {
    const sql = 'BEGIN TRANSACTION;\nCREATE TABLE d (id int);\nCOMMIT;\n';
    expect(executedIsClean(sql)).toBe(false);
    expect(readOne('0902_begin_transaction.sql', sql)).toThrow(
      UnsafeMigrationError,
    );
  });

  it('strips through a leading block comment, keeping the comment', () => {
    const sql = '/* hdr */\nBEGIN;\nCREATE TABLE e (id int);\nCOMMIT;\n';
    expect(executedIsClean(sql)).toBe(true);
    const [file] = readOne('0903_leading_block.sql', sql)();
    expect(file.sql).not.toMatch(/\bBEGIN\b/i);
    expect(file.sql).toContain('/* hdr */');
  });

  it('accepts every real migration in drizzle/migrations', () => {
    // The guard must reject dangerous shapes without rejecting the 36 files
    // that actually ship — an over-strict guard would refuse to boot.
    const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(findTransactionControl(f.sql)).toEqual([]);
      expect(isExcluded(f.name)).toBe(false);
    }
  });

  it('still accepts the ordinary wrapped shape, and strips it', () => {
    const sql = 'BEGIN;\nALTER TABLE t ADD c int;\nCOMMIT;\n';
    expect(executedIsClean(sql)).toBe(true);
    const [file] = readOne('0904_ok.sql', sql)();
    expect(file.sql).toContain('ALTER TABLE t ADD c int;');
    expect(file.sql).not.toMatch(/BEGIN|COMMIT/i);
  });

  it('accepts a file with no transaction control at all', () => {
    const sql = 'CREATE TABLE t (id int);\n';
    expect(readOne('0905_bare.sql', sql)()[0].sql).toBe(sql);
  });

  it('does not mistake a DO block for a transaction', () => {
    const sql = [
      'BEGIN;',
      'DO $$',
      'BEGIN',
      "  RAISE EXCEPTION 'x';",
      'END $$;',
      'COMMIT;',
      '',
    ].join('\n');
    expect(executedIsClean(sql)).toBe(true);
    const [file] = readOne('0906_do_block.sql', sql)();
    expect(file.sql).toContain('DO $$');
    expect(file.sql).toContain('END $$;');
  });

  it('does not mistake the word COMMIT inside a comment for one', () => {
    const sql = '-- we COMMIT; nothing here\nCREATE TABLE t (id int);\n';
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it('does not mistake COMMIT inside a string literal for one', () => {
    const sql = "SELECT 'COMMIT;' AS note;\n";
    expect(findTransactionControl(sql)).toEqual([]);
  });
});

describe('isExcluded tolerates near-misses', () => {
  // This marker is the only thing between a hand-run alternative and automatic
  // execution of the destructive migration it replaces.
  it('excludes any case', () => {
    expect(isExcluded('0030_x.prod-safe.sql')).toBe(true);
    expect(isExcluded('0030_x.Prod-Safe.sql')).toBe(true);
    expect(isExcluded('0030_x.PROD-SAFE.sql')).toBe(true);
  });

  it('excludes the underscore spelling too', () => {
    expect(isExcluded('0030_x.PROD_SAFE.sql')).toBe(true);
    expect(isExcluded('0030_x.prod_safe.sql')).toBe(true);
  });

  it('still does not exclude ordinary migrations', () => {
    expect(isExcluded('0030_billing_account_scope.sql')).toBe(false);
    expect(isExcluded('0035_error_logs.sql')).toBe(false);
  });
});

describe('transaction-control variants with a tail (round-2 review)', () => {
  // Postgres accepts a tail on most transaction statements. An earlier regex
  // required the semicolon right after the keyword and missed every one.
  const leftoverAfterStrip = (sql: string) =>
    findTransactionControl(stripOuterTransaction(sql)).map((c) => c.keyword);

  it('catches COMMIT AND CHAIN — it commits AND reopens, splitting the file', () => {
    const sql =
      'BEGIN;\nCREATE TABLE a (id int);\nCOMMIT AND CHAIN;\n' +
      'CREATE TABLE b (id int);\nCOMMIT;\n';
    expect(leftoverAfterStrip(sql).length).toBeGreaterThan(0);
    expect(readOne('0910_chain.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('catches BEGIN ISOLATION LEVEL ...', () => {
    const sql =
      'CREATE TABLE d3 (id int);\nCOMMIT;\n' +
      'BEGIN ISOLATION LEVEL SERIALIZABLE;\nCREATE TABLE d4 (id int);\n';
    expect(readOne('0911_isolation.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('catches ABORT — safe in effect, but must never pass silently', () => {
    const sql = 'BEGIN;\nCREATE TABLE z (id int);\nABORT;\nCOMMIT;\n';
    expect(readOne('0912_abort.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('catches PREPARE TRANSACTION, which would strand a prepared txn', () => {
    const sql = "BEGIN;\nCREATE TABLE p (id int);\nPREPARE TRANSACTION 'g';\n";
    expect(readOne('0913_prepare.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('catches SAVEPOINT / ROLLBACK TO SAVEPOINT', () => {
    const sql = 'SAVEPOINT s;\nCREATE TABLE q (id int);\nROLLBACK TO SAVEPOINT s;\n';
    expect(readOne('0914_savepoint.sql', sql)).toThrow(UnsafeMigrationError);
  });

  it('still strips the plain wrapper, and still accepts every real migration', () => {
    const sql = 'BEGIN;\nALTER TABLE t ADD c int;\nCOMMIT;\n';
    expect(leftoverAfterStrip(sql)).toEqual([]);
    const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(findTransactionControl(f.sql)).toEqual([]);
  });

  it('does not mistake a DO block END; for transaction control', () => {
    const sql = [
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'hi';",
      'END;',
      '$$;',
      '',
    ].join('\n');
    expect(findTransactionControl(sql)).toEqual([]);
  });
});
