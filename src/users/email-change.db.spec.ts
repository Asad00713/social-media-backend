import { HttpException, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthService } from '../auth/auth.service';
import type { GeoipService } from '../auth/services/geoip.service';
import { AppLinks } from '../email/links/app-links';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import { SecurityActionsService } from '../email/public/security-actions.service';
import type { ChangeEmailCodeProps } from '../email/templates/security/change-email-code';
import type {
  EmailTokensService,
  SecurityClaims,
} from '../email/tokens/email-tokens.service';
import type { RecipientsService } from '../notifications/recipients.service';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import { AccountSecurityService } from './account-security.service';
import { EmailChangeService } from './email-change.service';

const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0073_users_email_changed_at.sql',
];
/** The squatter cases also seed a known_devices row. */
const SQUAT_MIGRATIONS = [...MIGRATIONS, '0072_known_devices.sql'];
const CTX = { ip: null, userAgent: null };
const rand = () => Math.random().toString(36).slice(2, 10);

interface UserState {
  email: string;
  is_email_verified: boolean;
  pending_email: string | null;
  pending_email_code_hash: string | null;
  pending_email_attempts: number;
  sessions_revoked_at: Date | null;
  email_changed_at: Date | null;
}

async function seedUser(client: PoolClient, email: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Rehman') RETURNING id`,
    [email],
  );
  return r.rows[0].id;
}

async function stateOf(client: PoolClient, id: string): Promise<UserState> {
  const r = await client.query<UserState>(
    `SELECT email, is_email_verified, pending_email, pending_email_code_hash,
            pending_email_attempts, sessions_revoked_at, email_changed_at
       FROM users WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/** The real services on the harness transaction; only mail, GeoIP and the clock-free bits are faked. */
function build(db: DbType) {
  const sendNow = jest.fn().mockResolvedValue({ success: true });
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const outbox = { sendNow, enqueue } as unknown as EmailOutboxService;
  const links = new AppLinks({ get: () => undefined } as never);
  // Only the database-backed methods run: revokeSessions, verifyCurrentPassword, deviceLabel.
  const none = null as never;
  const security = new AccountSecurityService(
    db,
    none,
    none,
    none,
    links,
    none,
    none,
  );
  const minted: SecurityClaims[] = [];
  const tokens = {
    // A real token carries its issue time; the revert compares a squatter's
    // created_at with it.
    securityToken: (c: SecurityClaims) => {
      minted.push({ ...c, iat: Math.floor(Date.now() / 1000) });
      return `tok${minted.length}`;
    },
    verifySecurity: (t: string) => minted[Number(t.slice(3)) - 1] ?? null,
  };
  const changes = new EmailChangeService(
    db,
    security,
    outbox,
    tokens as unknown as EmailTokensService,
    links,
    { lookup: () => Promise.resolve(null) } as unknown as GeoipService,
    {
      userTimezone: () => Promise.resolve('UTC'),
    } as unknown as RecipientsService,
  );
  const auth = { issuePasswordReset: jest.fn().mockResolvedValue(true) };
  const actions = new SecurityActionsService(
    db,
    tokens as unknown as EmailTokensService,
    security,
    auth as unknown as AuthService,
    links,
  );
  /** The code the last A3 carried. */
  const lastCode = () => {
    const calls = sendNow.mock.calls as [EnqueueEmail<ChangeEmailCodeProps>][];
    return calls[calls.length - 1][0].props.code;
  };
  return { changes, actions, lastCode, enqueue, auth };
}

async function codeOf(
  p: Promise<unknown>,
): Promise<{ status: number; code: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const body = e.getResponse() as { code?: unknown };
      return { status: e.getStatus(), code: body.code };
    }
    throw e;
  }
  throw new Error('expected a refusal');
}

describeDb('email change on a real database (0071, 0073)', () => {
  const savedAllowlist = process.env.ALLOWLIST_EMAILS;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The launch gate is off here: these addresses are not on any list.
    delete process.env.ALLOWLIST_EMAILS;
  });
  afterAll(() => {
    if (savedAllowlist !== undefined) {
      process.env.ALLOWLIST_EMAILS = savedAllowlist;
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('another user registers the new address between request and confirm → 409 EMAIL_TAKEN, users row unchanged, no 500', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const old = `old-${rand()}@example.test`;
      const wanted = `new-${rand()}@example.test`;
      const id = await seedUser(client, old);
      const { changes, lastCode, enqueue } = build(db);

      await changes.request(id, { newEmail: wanted });
      const before = await stateOf(client, id);
      // The signup that wins the race, stored as typed (mixed case).
      await seedUser(client, wanted.toUpperCase());

      const refused = await codeOf(changes.confirm(id, lastCode(), CTX));

      expect(refused).toEqual({ status: 409, code: 'EMAIL_TAKEN' });
      expect(await stateOf(client, id)).toEqual(before);
      expect(before.email).toBe(old);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it('a right code switches the email inside the transaction; 5 wrong codes lock and clear it', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const old = `Old-${rand()}@Example.test`;
      const wanted = `new-${rand()}@example.test`;
      const id = await seedUser(client, old);
      const { changes, lastCode } = build(db);

      await changes.request(id, { newEmail: wanted });
      for (let i = 0; i < 4; i++) {
        await expect(
          codeOf(changes.confirm(id, 'abcdef', CTX)),
        ).resolves.toEqual({
          status: 400,
          code: 'CODE_INVALID',
        });
      }
      expect((await stateOf(client, id)).pending_email_attempts).toBe(4);
      await expect(codeOf(changes.confirm(id, 'abcdef', CTX))).resolves.toEqual(
        {
          status: 400,
          code: 'CODE_LOCKED',
        },
      );
      expect(await stateOf(client, id)).toMatchObject({
        email: old,
        pending_email: null,
        pending_email_code_hash: null,
        pending_email_attempts: 0,
      });

      await changes.request(id, { newEmail: wanted });
      const user = await changes.confirm(id, lastCode(), CTX);

      expect(user.email).toBe(wanted);
      expect(await stateOf(client, id)).toMatchObject({
        email: wanted,
        is_email_verified: true,
        pending_email: null,
        pending_email_code_hash: null,
      });
    });
  });

  it('a second change inside 7 days is locked; once the window passes, a link minted before it refuses but signs out', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = `a-${rand()}@example.test`;
      const b = `b-${rand()}@example.test`;
      const c = `c-${rand()}@example.test`;
      const id = await seedUser(client, a);
      const { changes, actions, lastCode, auth } = build(db);

      // a -> b (tok1: from a to b) starts the 7-day lock.
      await changes.request(id, { newEmail: b });
      await changes.confirm(id, lastCode(), CTX);
      expect((await stateOf(client, id)).email_changed_at).toBeInstanceOf(Date);
      await expect(
        codeOf(changes.request(id, { newEmail: c })),
      ).resolves.toEqual({ status: 409, code: 'EMAIL_CHANGE_LOCKED' });

      // Eight days later b -> c (tok2: from b to c) goes through.
      await client.query(
        `UPDATE users SET email_changed_at = now() - interval '8 days' WHERE id = $1`,
        [id],
      );
      await changes.request(id, { newEmail: c });
      await changes.confirm(id, lastCode(), CTX);

      // tok1 would put the account back on `a`, but the account is on `c`
      // now: it refuses, and still signs every session out.
      const stale = await actions.perform('tok1');
      expect(stale?.title).toBe("Your email wasn't switched back");
      const refused = await stateOf(client, id);
      expect(refused.email).toBe(c);
      expect(refused.sessions_revoked_at).toBeInstanceOf(Date);
      expect(auth.issuePasswordReset).not.toHaveBeenCalled();

      // tok2 still describes the current state: back to `b`, signed out.
      const done = await actions.perform('tok2');
      expect(done?.title).toBe('Your account is secured');
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
      expect(auth.issuePasswordReset).toHaveBeenCalledWith({ id, email: b });
      // The revert restarts the 7-day lock.
      expect(after.email_changed_at?.getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });
  });

  it('the revert refuses when the old address belongs to someone else now', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = `a-${rand()}@example.test`;
      const b = `b-${rand()}@example.test`;
      const id = await seedUser(client, a);
      const { changes, actions, lastCode } = build(db);

      await changes.request(id, { newEmail: b });
      await changes.confirm(id, lastCode(), CTX);
      // Someone else's real (verified) account now signs in with `a`.
      const other = await seedUser(client, a);
      await client.query(
        'UPDATE users SET is_email_verified = true WHERE id = $1',
        [other],
      );

      const done = await actions.perform('tok1');

      expect(done?.title).toBe("Your email wasn't switched back");
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      // Every refusal still signs the account out everywhere.
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
    });
  });
});

describeDb('revert against a squatter registration (0072, 0073)', () => {
  const savedAllowlist = process.env.ALLOWLIST_EMAILS;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delete process.env.ALLOWLIST_EMAILS;
  });
  afterAll(() => {
    if (savedAllowlist !== undefined) {
      process.env.ALLOWLIST_EMAILS = savedAllowlist;
    }
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * a -> b on the victim's account, then someone registers `a`. now() is the
   * harness transaction's start, so the squatter's created_at is set from
   * clock_timestamp() (after the link) or a day back (before it).
   */
  async function squatted(
    db: DbType,
    client: PoolClient,
    holder: { verified: boolean; createdAfterLink: boolean },
  ) {
    const a = `a-${rand()}@example.test`;
    const b = `b-${rand()}@example.test`;
    const id = await seedUser(client, a);
    const built = build(db);
    await built.changes.request(id, { newEmail: b });
    await built.changes.confirm(id, built.lastCode(), CTX);
    const created = holder.createdAfterLink
      ? `clock_timestamp()::timestamp`
      : `(clock_timestamp() - interval '1 day')::timestamp`;
    const r = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, is_email_verified, created_at)
       VALUES ($1, 'Squatter', $2, ${created}) RETURNING id`,
      [a, holder.verified],
    );
    const squatter = r.rows[0].id;
    // The device the registration signed in from: a trace, not data.
    await client.query(
      `INSERT INTO known_devices (user_id, device_hash, label) VALUES ($1, $2, 'Chrome on Windows')`,
      [squatter, 'f'.repeat(64)],
    );
    return { ...built, id, a, b, squatter };
  }

  const exists = async (client: PoolClient, id: string) =>
    (await client.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount ===
    1;

  it('an unverified account registered on the old address after the link is removed, and the revert goes through', async () => {
    await withRollbackDb(SQUAT_MIGRATIONS, async (db, client) => {
      const { actions, auth, id, a, squatter } = await squatted(db, client, {
        verified: false,
        createdAfterLink: true,
      });

      const done = await actions.perform('tok1');

      expect(done?.title).toBe('Your account is secured');
      expect(await exists(client, squatter)).toBe(false);
      const after = await stateOf(client, id);
      expect(after.email).toBe(a);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
      expect(auth.issuePasswordReset).toHaveBeenCalledWith({ id, email: a });
    });
  });

  it('a verified holder of the old address still refuses, and the victim account is signed out everywhere', async () => {
    await withRollbackDb(SQUAT_MIGRATIONS, async (db, client) => {
      const { actions, auth, id, b, squatter } = await squatted(db, client, {
        verified: true,
        createdAfterLink: true,
      });

      const done = await actions.perform('tok1');

      expect(done?.title).toBe("Your email wasn't switched back");
      expect(await exists(client, squatter)).toBe(true);
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
      expect(auth.issuePasswordReset).not.toHaveBeenCalled();
    });
  });

  it('an unverified holder created before the link still refuses, and signs out', async () => {
    await withRollbackDb(SQUAT_MIGRATIONS, async (db, client) => {
      const { actions, id, b, squatter } = await squatted(db, client, {
        verified: false,
        createdAfterLink: false,
      });

      const done = await actions.perform('tok1');

      expect(done?.title).toBe("Your email wasn't switched back");
      expect(await exists(client, squatter)).toBe(true);
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
    });
  });

  it('an unverified squatter that owns data is never deleted: refused, signed out', async () => {
    await withRollbackDb(SQUAT_MIGRATIONS, async (db, client) => {
      const { actions, id, b, squatter } = await squatted(db, client, {
        verified: false,
        createdAfterLink: true,
      });
      await client.query(
        `INSERT INTO workspace (name, slug, owner_id) VALUES ('w', $1, $2)`,
        [`w-${rand()}`, squatter],
      );

      const done = await actions.perform('tok1');

      expect(done?.title).toBe("Your email wasn't switched back");
      expect(await exists(client, squatter)).toBe(true);
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
    });
  });
});
