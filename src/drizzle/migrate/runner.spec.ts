import {
  checksumOf,
  isExcluded,
  planMigrations,
  stripOuterTransaction,
  type AppliedRow,
  type MigrationFile,
} from './runner';

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
