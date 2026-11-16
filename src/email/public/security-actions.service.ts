import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { AuthService } from '../../auth/auth.service';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { users } from '../../drizzle/schema/users.schema';
import { AccountSecurityService } from '../../users/account-security.service';
import { normalizeEmail } from '../../users/normalize-email';
import { AppLinks } from '../links/app-links';
import {
  EmailTokensService,
  type SecurityClaims,
} from '../tokens/email-tokens.service';

/** The confirm page a GET shows. */
export interface SecurityAsk {
  title: string;
  body: string;
  button: string;
}

/** The page a POST ends on. */
export interface SecurityDone {
  title: string;
  body: string;
}

interface Account {
  id: string;
  email: string;
}

/** The root db or the revert transaction. */
type Executor = DbType | Parameters<Parameters<DbType['transaction']>[0]>[0];

/** A revert claim always names both addresses (Task 7 mints it so). */
type RevertClaims = SecurityClaims & { from: string; to: string };

type RevertResult =
  | { kind: 'reverted'; account: Account }
  | { kind: 'already' }
  | { kind: 'refused' }
  | { kind: 'gone' };

/**
 * Tables whose rows a bare sign-up leaves behind and nobody would miss: the
 * device a registration signs in from. Any other row pointing at a squatter
 * means it holds data, and it is never deleted.
 */
const SIGN_IN_TRACE_TABLES = new Set(['known_devices']);

const SECURE_BUTTON = 'Secure my account';
const SECURED_TITLE = 'Your account is secured';
const RESET_NOT_SENT =
  'We signed you out everywhere, but we couldn\'t send the reset link. Choose a new password with "Forgot password" on the sign-in page.';

/** `r•••@lumierecafe.pk`: enough to recognise the address, not to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

function isRevert(claims: SecurityClaims): claims is RevertClaims {
  return (
    claims.act === 'revert_email' &&
    typeof claims.from === 'string' &&
    typeof claims.to === 'string'
  );
}

/** node-postgres reports unique violations as 23505, sometimes wrapped by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * The security links in A4 ("Secure my account", `revert_email`), A5 ("Reset
 * password") and A6 ("This wasn't me"), both `not_me` (spec §7.3).
 *
 * `describe` backs the GET and only reads, because mail scanners open every
 * link in a message. `perform` backs the POST. Both answer null for a bad,
 * expired or tampered token, or a deleted account, and the caller shows the
 * "This link doesn't work" page.
 *
 * Securing means: every session ends (`revokeSessions`), any email change
 * still waiting for its code is cancelled, and a fresh reset link goes to the
 * account's address through the same path as "Forgot password", which also
 * voids any reset link issued before.
 */
@Injectable()
export class SecurityActionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly tokens: EmailTokensService,
    private readonly security: AccountSecurityService,
    private readonly auth: AuthService,
    private readonly links: AppLinks,
  ) {}

  async describe(token: string): Promise<SecurityAsk | null> {
    const claims = this.tokens.verifySecurity(token);
    if (!claims) return null;
    const account = await this.account(claims.uid);
    if (!account) return null;
    if (claims.act === 'revert_email') {
      if (!isRevert(claims)) return null;
      return {
        title: 'Switch your email back?',
        body: `Your sign-in email will go back to ${claims.from}, we'll sign you out everywhere, and we'll send a reset link there.`,
        button: SECURE_BUTTON,
      };
    }
    return {
      title: 'Secure your account?',
      body: `We'll sign you out everywhere and send a password reset link to ${maskEmail(account.email)}.`,
      button: SECURE_BUTTON,
    };
  }

  /**
   * Safe to repeat. `not_me` secures the account each time. A revert switches
   * the email only while it is still the address the link was sent about
   * (`to`); once switched, a repeat finds the email already back at `from`
   * and says so without signing out or mailing again (it secures again only
   * if a new email change has been started since). After any other change,
   * or when another account holds `from`, the link refuses and leaves the
   * email alone, so an old link can never move the account onto an address
   * it no longer uses. Every refusal still signs out everywhere and cancels a
   * pending change: the clicker reads an address the account had, and
   * whoever made the change (victim → a1 → a2, or a squatter registration on
   * victim@) must not stay signed in. No reset link: it would go to the
   * account's current address, which may be the attacker's.
   */
  async perform(token: string): Promise<SecurityDone | null> {
    const claims = this.tokens.verifySecurity(token);
    if (!claims) return null;

    if (claims.act === 'not_me') {
      const account = await this.account(claims.uid);
      if (!account) return null;
      const sent = await this.secure(account);
      return {
        title: SECURED_TITLE,
        body: sent
          ? `We signed you out everywhere and sent a reset link to ${maskEmail(account.email)}.`
          : RESET_NOT_SENT,
      };
    }

    if (!isRevert(claims)) return null;
    const result = await this.revertEmail(claims);
    if (result.kind === 'gone') return null;
    if (result.kind === 'already') {
      return {
        title: 'This is already done',
        body: `Your sign-in email is already back to ${maskEmail(claims.from)}.`,
      };
    }
    if (result.kind === 'refused') {
      await this.protect(claims.uid);
      return {
        title: "Your email wasn't switched back",
        body: `We couldn't switch your email back. Write to ${this.links.supportEmail()} and we'll help.`,
      };
    }
    const sent = await this.secure(result.account);
    return {
      title: SECURED_TITLE,
      body: sent
        ? `Your sign-in email is ${result.account.email} again. We signed you out everywhere and sent a reset link there.`
        : `Your sign-in email is ${result.account.email} again. ${RESET_NOT_SENT}`,
    };
  }

  /**
   * In one transaction with the row locked: the email goes back to `from`
   * only while it is still `to` and no other account has taken `from`.
   * The click proves the person reads `from` (the link was mailed there), so
   * the address counts as verified.
   *
   * One holder of `from` does not block: a squatter, i.e. an UNVERIFIED
   * account created after the link was minted that holds nothing but its
   * sign-in trace. That is the attacker registering the vacated address to
   * defeat this link. It is deleted in this transaction and the revert goes
   * on. Its row stays locked from the check to the delete, so no data can
   * be attached to it in between.
   */
  private async revertEmail(claims: RevertClaims): Promise<RevertResult> {
    const from = normalizeEmail(claims.from);
    try {
      return await this.db.transaction(async (tx): Promise<RevertResult> => {
        const [row] = await tx
          .select({ email: users.email, pendingEmail: users.pendingEmail })
          .from(users)
          .where(eq(users.id, claims.uid))
          .for('update');
        if (!row) return { kind: 'gone' };
        const current = normalizeEmail(row.email);
        if (current === from) {
          // Already switched back. Nothing to undo, unless a new change has
          // been started since: then secure again, which cancels it.
          if (!row.pendingEmail) return { kind: 'already' };
          return {
            kind: 'reverted',
            account: { id: claims.uid, email: row.email },
          };
        }
        if (current !== normalizeEmail(claims.to)) return { kind: 'refused' };

        const [holder] = await tx
          .select({
            id: users.id,
            isEmailVerified: users.isEmailVerified,
            // created_at is a bare timestamp written by now(): compare it in
            // the database, in the same session time zone, never in JS.
            createdAfterLink: sql<boolean>`coalesce(${users.createdAt} > to_timestamp(${claims.iat ?? null}::double precision)::timestamp, false)`,
          })
          .from(users)
          .where(
            and(sql`lower(${users.email}) = ${from}`, ne(users.id, claims.uid)),
          )
          .limit(1)
          .for('update');
        if (holder) {
          const isSquatter =
            !holder.isEmailVerified &&
            holder.createdAfterLink &&
            (await this.holdsNothing(tx, holder.id));
          if (!isSquatter) return { kind: 'refused' };
          await tx.delete(users).where(eq(users.id, holder.id));
        }

        await tx
          .update(users)
          .set({
            email: claims.from,
            isEmailVerified: true,
            emailChangedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, claims.uid));
        return {
          kind: 'reverted',
          account: { id: claims.uid, email: claims.from },
        };
      });
    } catch (err) {
      // `from` was registered between the check and the write.
      if (isUniqueViolation(err)) return { kind: 'refused' };
      throw err;
    }
  }

  /**
   * True when no row in any table points at `userId` through a foreign key,
   * apart from its sign-in trace (SIGN_IN_TRACE_TABLES). Read from the
   * catalogue, so a table added later is covered without a code change.
   */
  private async holdsNothing(tx: Executor, userId: string): Promise<boolean> {
    const refs = await tx.execute<{ tbl: string; col: string }>(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`);
    const probes = refs.rows
      .filter((r) => !SIGN_IN_TRACE_TABLES.has(r.tbl))
      // The table name comes from the catalogue, already quoted by regclass.
      .map(
        (r) =>
          sql`(SELECT 1 FROM ${sql.raw(r.tbl)} WHERE ${sql.identifier(r.col)} = ${userId} LIMIT 1)`,
      );
    if (probes.length === 0) return true;
    const found = await tx.execute(sql.join(probes, sql` UNION ALL `));
    return found.rows.length === 0;
  }

  /** Signs out everywhere, cancels a pending email change, mails a reset link. */
  private async secure(account: Account): Promise<boolean> {
    await this.protect(account.id);
    return this.auth.issuePasswordReset(account);
  }

  /** Signs out everywhere and cancels a pending email change. */
  private async protect(userId: string): Promise<void> {
    await this.security.revokeSessions(userId);
    await this.db
      .update(users)
      .set({
        pendingEmail: null,
        pendingEmailCodeHash: null,
        pendingEmailExpiresAt: null,
        pendingEmailAttempts: 0,
      })
      .where(eq(users.id, userId));
  }

  private async account(uid: string): Promise<Account | null> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.id, uid),
      columns: { id: true, email: true },
    });
    return row ?? null;
  }
}
