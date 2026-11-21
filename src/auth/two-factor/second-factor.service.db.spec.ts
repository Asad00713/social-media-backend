import { Secret, TOTP } from 'otpauth';
import type { PoolClient } from 'pg';
import { encryptTotpSecret } from '../../common/utils/totp-secret.util';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { SecondFactorService } from './second-factor.service';

const MIGRATIONS = [
  '0072_known_devices.sql',
  '0098_user_sessions.sql',
  '0099_two_factor.sql',
];
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const rand = () => Math.random().toString(36).slice(2, 10);

const codeAt = (ms: number) =>
  TOTP.generate({
    secret: Secret.fromBase32(SECRET),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: ms,
  });

/** A user with SECRET as the active (or pending) seed, encrypted. */
async function seedUser(
  client: PoolClient,
  opts: { pending?: boolean; plaintext?: boolean } = {},
): Promise<string> {
  const stored = opts.plaintext ? SECRET : encryptTotpSecret(SECRET);
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, totp_secret_enc, totp_pending_secret_enc, totp_enabled_at)
     VALUES ($1, 'Two Step', $2, $3, $4) RETURNING id`,
    [
      `2fa-${rand()}@example.test`,
      opts.pending ? null : stored,
      opts.pending ? stored : null,
      opts.pending ? null : new Date(),
    ],
  );
  return r.rows[0].id;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
};

async function failures(client: PoolClient, userId: string) {
  const r = await client.query<{
    mfa_failures: number;
    locked_for: number | null;
  }>(
    `SELECT mfa_failures,
            extract(epoch FROM (mfa_locked_until - now()))::float AS locked_for
       FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0];
}

describeDb('SecondFactorService (database)', () => {
  const build = (db: DbType) => new SecondFactorService(db);

  it('a valid TOTP passes once; the same code again is a replay → MFA_CODE_INVALID', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const code = codeAt(Date.now());
      return {
        first: await s.check(userId, { code }),
        second: await codeOf(s.check(userId, { code })),
      };
    });
    expect(r.first.method).toBe('totp');
    expect(r.second).toBe('MFA_CODE_INVALID');
  });

  it('an older step after a newer one is rejected', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const now = Date.now();
      await s.check(userId, { code: codeAt(now) });
      return codeOf(s.check(userId, { code: codeAt(now - 30_000) }));
    });
    expect(r).toBe('MFA_CODE_INVALID');
  });

  it('a backup code works once; the second use is MFA_CODE_INVALID', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const [code] = await s.replaceBackupCodes(userId);
      return {
        first: await s.check(userId, { backupCode: code }),
        second: await codeOf(s.check(userId, { backupCode: code })),
      };
    });
    expect(r.first).toEqual({ method: 'backup', backupCodesRemaining: 9 });
    expect(r.second).toBe('MFA_CODE_INVALID');
  });

  it('a backup code typed lower-case with O/I and spaces still matches', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const codes = await s.replaceBackupCodes(userId);
      // Pick one with a 0 or 1 to type as O / I; fall back to any code.
      const pick = codes.find((c) => /[01]/.test(c)) ?? codes[0];
      const typed =
        ' ' +
        pick
          .replace('-', ' ')
          .replace(/0/g, 'o')
          .replace(/1/g, 'I')
          .toLowerCase() +
        ' ';
      return s.check(userId, { backupCode: typed });
    });
    expect(r.method).toBe('backup');
  });

  it('backupCodesRemaining counts down, and status reports it', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const codes = await s.replaceBackupCodes(userId);
      const left: number[] = [];
      for (const c of codes.slice(0, 3))
        left.push(
          (await s.check(userId, { backupCode: c })).backupCodesRemaining,
        );
      return { left, status: await s.status(userId) };
    });
    expect(r.left).toEqual([9, 8, 7]);
    expect(r.status).toMatchObject({ enabled: true, backupCodesRemaining: 7 });
    expect(r.status.enabledAt).toBeInstanceOf(Date);
  });

  it('the 10th consecutive failure locks for 15 minutes; the correct code during the lock is MFA_LOCKED with retryAfterSeconds ≈ 900', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const codes: string[] = [];
      for (let i = 0; i < 9; i++)
        codes.push(await codeOf(s.check(userId, { code: '000000' })));
      const afterNine = await failures(client, userId);
      let tenth: unknown;
      try {
        await s.check(userId, { code: '000000' });
      } catch (e) {
        tenth = (e as { getResponse(): unknown }).getResponse();
      }
      const afterTen = await failures(client, userId);
      let during: unknown;
      try {
        await s.check(userId, { code: codeAt(Date.now()) });
      } catch (e) {
        during = (e as { getResponse(): unknown }).getResponse();
      }
      // A guess during the lock is refused before it is judged or counted.
      const duringWrong = await codeOf(s.check(userId, { code: '000000' }));
      const afterDuring = await failures(client, userId);
      return {
        codes,
        afterNine,
        tenth,
        afterTen,
        during,
        duringWrong,
        afterDuring,
      };
    });
    expect(r.duringWrong).toBe('MFA_LOCKED');
    expect(r.afterDuring.mfa_failures).toBe(0);
    expect(new Set(r.codes)).toEqual(new Set(['MFA_CODE_INVALID']));
    expect(r.afterNine.mfa_failures).toBe(9);
    expect(r.tenth).toMatchObject({ code: 'MFA_LOCKED' });
    // B3: the lock resets the count.
    expect(r.afterTen.mfa_failures).toBe(0);
    expect(r.afterTen.locked_for).toBeGreaterThan(890);
    expect(r.during).toMatchObject({ code: 'MFA_LOCKED', statusCode: 429 });
    const retry = (r.during as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(retry).toBeGreaterThan(890);
    expect(retry).toBeLessThanOrEqual(900);
  });

  it('a burst of 20 parallel wrong codes: at most 10 are judged, then the account is locked', async () => {
    // node-postgres queues every statement on the one connection, so a
    // read-the-lock-then-check implementation lets all 20 past its SELECT
    // (19 MFA_CODE_INVALID). With the attempt reserved first, only failures
    // 1-9 answer MFA_CODE_INVALID; the 10th sets the lock and the rest are
    // refused unjudged.
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          codeOf(s.check(userId, { code: '000000' })),
        ),
      );
      return { answers, after: await failures(client, userId) };
    });
    expect(r.answers.filter((a) => a === 'MFA_CODE_INVALID')).toHaveLength(9);
    expect(r.answers.filter((a) => a === 'MFA_LOCKED')).toHaveLength(11);
    expect(r.after.locked_for).toBeGreaterThan(890);
  });

  it('a right code sent after 10 parallel wrong ones is refused (MFA_LOCKED), not accepted', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const wrong = Array.from({ length: 10 }, () =>
        codeOf(s.check(userId, { code: '000000' })),
      );
      const right = codeOf(s.check(userId, { code: codeAt(Date.now()) }));
      const answers = await Promise.all([...wrong, right]);
      const last = await client.query<{ step: string | null }>(
        `SELECT totp_last_step::text AS step FROM users WHERE id = $1`,
        [userId],
      );
      return { right: answers[10], step: last.rows[0].step };
    });
    expect(r.right).toBe('MFA_LOCKED');
    // The code was never accepted: the replay guard never moved.
    expect(r.step).toBeNull();
  });

  it('the TOTP replay guard and the backup-code spend refuse in their own UPDATE once locked', async () => {
    // A reservation taken just before a parallel guess set the lock reaches
    // these statements with the lock already on; they must refuse it.
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const [backup] = await s.replaceBackupCodes(userId);
      await client.query(
        `UPDATE users SET mfa_locked_until = now() + interval '15 minutes' WHERE id = $1`,
        [userId],
      );
      const seam = s as unknown as {
        totpOk(u: string, enc: string, code: string): Promise<boolean>;
        spendBackupCode(u: string, code: string): Promise<boolean>;
      };
      const enc = await client.query<{ enc: string }>(
        `SELECT totp_secret_enc AS enc FROM users WHERE id = $1`,
        [userId],
      );
      const totp = await seam.totpOk(
        userId,
        enc.rows[0].enc,
        codeAt(Date.now()),
      );
      const spent = await seam.spendBackupCode(userId, backup);
      const unused = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      return { totp, spent, unused: unused.rows[0].n };
    });
    expect(r).toEqual({ totp: false, spent: false, unused: '10' });
  });

  it('a success resets mfa_failures', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      for (let i = 0; i < 3; i++)
        await codeOf(s.check(userId, { code: '000000' }));
      const before = (await failures(client, userId)).mfa_failures;
      await s.check(userId, { code: codeAt(Date.now()) });
      return { before, after: (await failures(client, userId)).mfa_failures };
    });
    expect(r).toEqual({ before: 3, after: 0 });
  });

  it('a plaintext totp_secret_enc never verifies (decryptStrict)', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client, { plaintext: true });
      return codeOf(build(db).check(userId, { code: codeAt(Date.now()) }));
    });
    expect(r).toBe('MFA_CODE_INVALID');
  });

  it('the pending secret verifies setup codes; a backup code cannot satisfy it', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client, { pending: true });
      const s = build(db);
      await client.query(
        `INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, 'x'.repeat(64)],
      );
      const codes = await s.replaceBackupCodes(userId);
      return {
        backup: await codeOf(
          s.check(userId, { backupCode: codes[0] }, { secret: 'pending' }),
        ),
        activeIsEmpty: await codeOf(
          s.check(userId, { code: codeAt(Date.now()) }),
        ),
        pending: await codeOf(
          s.check(userId, { code: codeAt(Date.now()) }, { secret: 'pending' }),
        ),
      };
    });
    expect(r.backup).toBe('MFA_CODE_INVALID');
    expect(r.activeIsEmpty).toBe('MFA_CODE_INVALID');
    expect(r.pending).toBe('ok');
  });

  it('clear nulls the TOTP columns, deletes codes and mfa challenges, clears trust', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      await s.replaceBackupCodes(userId);
      await client.query(
        `INSERT INTO login_challenges (user_id, purpose, expires_at)
         VALUES ($1, 'mfa', now() + interval '5 minutes'),
                ($1, 'admin_email', now() + interval '5 minutes')`,
        [userId],
      );
      await client.query(
        `INSERT INTO known_devices (user_id, device_hash, label, mfa_trusted_until)
         VALUES ($1, $2, 'Chrome on Windows', now() + interval '30 days')`,
        [userId, 'e'.repeat(64)],
      );
      await client.query(
        `UPDATE users SET mfa_failures = 4, totp_last_step = 99 WHERE id = $1`,
        [userId],
      );
      await s.clear(userId);
      const u = await client.query<Record<string, unknown>>(
        `SELECT totp_secret_enc, totp_pending_secret_enc, totp_enabled_at,
                totp_last_step, mfa_failures, mfa_locked_until
           FROM users WHERE id = $1`,
        [userId],
      );
      const counts = await client.query<{
        codes: string;
        mfa: string;
        admin: string;
        trusted: string;
      }>(
        `SELECT (SELECT count(*) FROM user_backup_codes WHERE user_id = $1) AS codes,
                (SELECT count(*) FROM login_challenges WHERE user_id = $1 AND purpose = 'mfa') AS mfa,
                (SELECT count(*) FROM login_challenges WHERE user_id = $1 AND purpose = 'admin_email') AS admin,
                (SELECT count(*) FROM known_devices WHERE user_id = $1 AND mfa_trusted_until IS NOT NULL) AS trusted`,
        [userId],
      );
      return {
        user: u.rows[0],
        counts: counts.rows[0],
        enabled: await s.isEnabled(userId),
      };
    });
    expect(r.user).toEqual({
      totp_secret_enc: null,
      totp_pending_secret_enc: null,
      totp_enabled_at: null,
      totp_last_step: null,
      mfa_failures: 0,
      mfa_locked_until: null,
    });
    expect(r.counts).toEqual({
      codes: '0',
      mfa: '0',
      admin: '1',
      trusted: '0',
    });
    expect(r.enabled).toBe(false);
  });

  it('regenerating replaces every code: an old code no longer works, a new one does', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const s = build(db);
      const [old] = await s.replaceBackupCodes(userId);
      const [fresh] = await s.replaceBackupCodes(userId);
      return {
        old: await codeOf(s.check(userId, { backupCode: old })),
        fresh: await codeOf(s.check(userId, { backupCode: fresh })),
      };
    });
    expect(r).toEqual({ old: 'MFA_CODE_INVALID', fresh: 'ok' });
  });

  it('replaceBackupCodes stores only peppered hashes, never the codes', async () => {
    const r = await withRollbackDb(MIGRATIONS, async (db, client) => {
      const userId = await seedUser(client);
      const codes = await build(db).replaceBackupCodes(userId);
      const rows = await client.query<{ code_hash: string }>(
        `SELECT code_hash FROM user_backup_codes WHERE user_id = $1`,
        [userId],
      );
      return { codes, hashes: rows.rows.map((x) => x.code_hash) };
    });
    expect(r.hashes).toHaveLength(10);
    for (const h of r.hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const c of r.codes) {
      expect(r.hashes.join()).not.toContain(c.replace('-', ''));
    }
  });
});
