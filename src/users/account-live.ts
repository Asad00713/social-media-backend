import { UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { users } from '../drizzle/schema/users.schema';

type Tx = Parameters<Parameters<DbType['transaction']>[0]>[0];

/**
 * Inside a transaction, before it writes anything that belongs to `userId`
 * (a workspace they own, a membership they hold): holds their `users` row
 * with FOR KEY SHARE and refuses a deleted account with 401 ACCOUNT_DELETED.
 *
 * Why a lock and not a read: account deletion takes the row FOR UPDATE and
 * stamps `deleted_at` in one transaction. A plain read here, or the FK check
 * of the insert, would see the row before that commit and go ahead, leaving
 * a workspace or an ACCEPTED membership on a deleted account (the delete's
 * "owns no workspace" and "every membership removed" checks ran before this
 * row existed). FOR KEY SHARE waits for the delete; once it commits,
 * PostgreSQL re-checks `deleted_at IS NULL` against the new row version, the
 * row no longer matches, and this refuses. A delete that starts after this
 * lock waits for this transaction instead, and then sees what it wrote.
 *
 * Take it FIRST in the transaction, before any seat lock or workspace row:
 * the delete locks the user row first and the rest after, so the same order
 * here means the two never deadlock.
 */
export async function lockLiveAccount(
  tx: Tx,
  userId: string,
  /**
   * What to throw for a deleted account. The default (401 ACCOUNT_DELETED)
   * is for the caller's OWN account; when the account is someone else's (a
   * member being restored), the caller passes its own error, or a 401 would
   * sign the actor out.
   */
  onDeleted?: () => Error,
): Promise<void> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .for('key share');
  if (!row) {
    if (onDeleted) throw onDeleted();
    // The same body as the strategies' assertNotDeleted (not imported: the
    // strategy module pulls in UsersService).
    throw new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'ACCOUNT_DELETED',
      message: 'This account has been deleted.',
    });
  }
}
