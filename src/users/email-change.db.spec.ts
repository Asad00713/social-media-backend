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
];
const CTX = { ip: null, userAgent: null };
const rand = () => Math.random().toString(36).slice(2, 10);

interface UserState {
  email: string;
  is_email_verified: boolean;
  pending_email: string | null;
  pending_email_code_hash: string | null;
  pending_email_attempts: number;
  sessions_revoked_at: Date | null;
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
            pending_email_attempts, sessions_revoked_at
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
    securityToken: (c: SecurityClaims) => {
      minted.push(c);
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

describeDb('email change on a real database (0071)', () => {
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

  it('the revert link switches back once; a link minted before a second change refuses', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = `a-${rand()}@example.test`;
      const b = `b-${rand()}@example.test`;
      const c = `c-${rand()}@example.test`;
      const id = await seedUser(client, a);
      const { changes, actions, lastCode, auth } = build(db);

      // a -> b (tok1: from a to b), then b -> c (tok2: from b to c).
      await changes.request(id, { newEmail: b });
      await changes.confirm(id, lastCode(), CTX);
      await changes.request(id, { newEmail: c });
      await changes.confirm(id, lastCode(), CTX);

      // tok1 would put the account back on `a`, but the account is on `c` now.
      const stale = await actions.perform('tok1');
      expect(stale?.title).toBe("Your email wasn't switched back");
      expect(await stateOf(client, id)).toMatchObject({
        email: c,
        sessions_revoked_at: null,
      });

      // tok2 still describes the current state: back to `b`, signed out.
      const done = await actions.perform('tok2');
      expect(done?.title).toBe('Your account is secured');
      const after = await stateOf(client, id);
      expect(after.email).toBe(b);
      expect(after.sessions_revoked_at).toBeInstanceOf(Date);
      expect(auth.issuePasswordReset).toHaveBeenCalledWith({ id, email: b });
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
      await seedUser(client, a);

      const done = await actions.perform('tok1');

      expect(done?.title).toBe("Your email wasn't switched back");
      expect((await stateOf(client, id)).email).toBe(b);
    });
  });
});
