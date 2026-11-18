import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  adDrafts,
  adminAuditLogs,
  adminLoginChallenges,
  canvaConnections,
  channelConnectLinks,
  conversations,
  feedbackDismissals,
  inboxUserSettings,
  insightHiddenSteps,
  knownDevices,
  maestroBridgeThreads,
  maestroChannelLinks,
  notificationPreferences,
  notifications,
  oauthStates,
  plannerPreferences,
  telegramChatBindings,
  users,
  workspace,
  workspaceInvitation,
} from '../drizzle/schema';
import { SubscriptionService } from '../billing/services/subscription.service';
import { UsageService } from '../billing/services/usage.service';
import { normalizeEmail } from './normalize-email';

type Executor = DbType | Parameters<Parameters<DbType['transaction']>[0]>[0];
type Tx = Parameters<Parameters<DbType['transaction']>[0]>[0];

export type DeletionActor = 'self' | 'super_admin';

export interface DeleteAccountInput {
  /** Required for `self`; a super admin deletes without it. */
  confirmEmail?: string;
  actor: DeletionActor;
  /** Who is deleting: the person themselves, or the super admin. */
  actorId: string;
}

/** One row of the 409 OWNS_WORKSPACES blocker list. */
export interface OwnedWorkspace {
  id: string;
  name: string;
}

/**
 * Personal tables with no migration in this repo (created by `db:push`), so
 * an environment may not have them. Deleting from a missing table would fail
 * the whole account delete; each is deleted from only when it exists.
 */
const PUSH_ONLY_TABLES = [
  'maestro_channel_links',
  'maestro_bridge_threads',
  'canva_connections',
] as const;

/**
 * Deletes an account the only way the system now allows: a soft delete that
 * anonymises the `users` row in place (spec §5.10). No HTTP path removes a
 * `users` row any more (the inactivity purge still does; see its TODO); the
 * row stays so every workspace record that names the person (posts,
 * comments, notes, invitations they sent, billing history) keeps a valid
 * author id.
 *
 * Order, and why:
 *  1. Email check (self only) and the owned-workspace block (409): neither
 *     changes anything.
 *  2. The account's subscription is cancelled at the provider, immediately.
 *     Outside the transaction (it is a network call); a failure is a 502 and
 *     nothing has been written.
 *  3. One transaction: memberships removed, personal rows deleted, the user
 *     row anonymised, an audit row written.
 *  4. After commit: each workspace the person left gets its member count
 *     decremented (best effort, like a normal member removal).
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
  ) {}

  async deleteAccount(
    userId: string,
    input: DeleteAccountInput,
  ): Promise<void> {
    const [user] = await this.db
      .select({ email: users.email, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    // Already deleted (an admin retry): nothing left to do.
    if (user.deletedAt) return;

    if (
      input.actor === 'self' &&
      normalizeEmail(input.confirmEmail ?? '') !== normalizeEmail(user.email)
    ) {
      throw emailMismatch();
    }

    const owned = await ownedWorkspaces(this.db, userId);
    if (owned.length > 0) throw ownsWorkspaces(owned);

    try {
      await this.subscriptions.cancelForAccount(userId, false, {
        changedByUserId: input.actorId,
      });
    } catch (error) {
      this.logger.error(
        `Account delete ${userId}: billing cancel failed, nothing changed: ${(error as Error)?.message}`,
      );
      throw billingCancelFailed();
    }

    const leftWorkspaces = await this.db.transaction((tx) =>
      this.deleteInTransaction(tx, userId, input),
    );
    if (!leftWorkspaces) return;

    // After commit, as a normal member removal does: a failed count update is
    // logged and never undoes the delete.
    for (const workspaceId of leftWorkspaces) {
      try {
        await this.usage.decrementMemberCount(workspaceId, userId, userId);
      } catch (error) {
        this.logger.warn(
          `Account delete ${userId}: member count of ${workspaceId} not decremented: ${(error as Error)?.message}`,
        );
      }
    }
  }

  /**
   * Everything that changes rows. Returns the workspaces an ACCEPTED
   * membership was removed from (their member counts drop after commit), or
   * null when a concurrent delete got there first.
   */
  private async deleteInTransaction(
    tx: Tx,
    userId: string,
    input: DeleteAccountInput,
  ): Promise<string[] | null> {
    // FOR UPDATE serialises two deletes of the same account, and blocks a
    // workspace insert naming this owner (its FK check takes KEY SHARE on
    // this row) until we commit.
    const [locked] = await tx
      .select({ email: users.email, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!locked || locked.deletedAt) return null;

    // Again under the lock: a workspace created since the first check.
    const ownedNow = await ownedWorkspaces(tx, userId);
    if (ownedNow.length > 0) throw ownsWorkspaces(ownedNow);

    const now = new Date();
    const left = await this.removeMemberships(tx, userId, locked.email, now);
    await this.deletePersonalRows(tx, userId, now);

    await tx
      .update(users)
      .set({
        // Unique per account, and on a reserved TLD that can never receive
        // mail, so the old address is free to register again.
        email: sql`'deleted+' || ${users.id}::text || '@deleted.invalid'`,
        name: null,
        password: null,
        googleSub: null,
        avatarUrl: null,
        pendingEmail: null,
        pendingEmailCodeHash: null,
        pendingEmailExpiresAt: null,
        pendingEmailAttempts: 0,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        preferences: {},
        notificationsPausedUntil: null,
        lastLoginIp: null,
        country: null,
        countryCode: null,
        isActive: false,
        deletedAt: now,
        // Every token minted before now is refused; the strategies also
        // refuse ACCOUNT_DELETED outright, whatever the token's iat.
        sessionsRevokedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    // No PII: ids only, never the old email or name.
    await tx.insert(adminAuditLogs).values({
      action: input.actor === 'self' ? 'user.self_delete' : 'user.admin_delete',
      actorId: input.actorId,
      actorEmail: null,
      targetType: 'user',
      targetId: userId,
      targetLabel: null,
    });

    return left;
  }

  /**
   * Every ACCEPTED or PENDING membership → REMOVED, by this person
   * (`removed_by = user` means "left on their own", never restorable). A
   * PENDING invitation also matches by email: one sent before the account
   * existed has no user_id. The accept token is replaced, as a normal removal
   * does, so an old link is dead twice over. Invitations the person SENT are
   * untouched (their invited_by stays; it is SET NULL only on a hard delete).
   */
  private async removeMemberships(
    tx: Tx,
    userId: string,
    email: string,
    now: Date,
  ): Promise<string[]> {
    const removed = {
      status: 'REMOVED' as const,
      removedAt: now,
      removedBy: userId,
      token: sql`replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')`,
      updatedAt: now,
    };

    const accepted = await tx
      .update(workspaceInvitation)
      .set(removed)
      .where(
        and(
          eq(workspaceInvitation.userId, userId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      )
      .returning({ workspaceId: workspaceInvitation.workspaceId });

    await tx
      .update(workspaceInvitation)
      .set(removed)
      .where(
        and(
          eq(workspaceInvitation.status, 'PENDING'),
          or(
            eq(workspaceInvitation.userId, userId),
            sql`lower(${workspaceInvitation.email}) = ${normalizeEmail(email)}`,
          ),
        ),
      );

    return [...new Set(accepted.map((r) => r.workspaceId))];
  }

  /**
   * The person's own data (spec §13 #17). Workspace data they authored stays:
   * posts, comments, inbox notes and replies, media, campaigns, drips, short
   * links, reports, calendar notes, saved replies, network requests, billing
   * rows, ai_usage_log, feedback, group Telegram bindings.
   */
  private async deletePersonalRows(
    tx: Tx,
    userId: string,
    now: Date,
  ): Promise<void> {
    await tx.delete(knownDevices).where(eq(knownDevices.userId, userId));
    await tx
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
    await tx
      .delete(plannerPreferences)
      .where(eq(plannerPreferences.userId, userId));
    await tx
      .delete(inboxUserSettings)
      .where(eq(inboxUserSettings.userId, userId));
    await tx
      .delete(insightHiddenSteps)
      .where(eq(insightHiddenSteps.userId, userId));
    await tx
      .delete(feedbackDismissals)
      .where(eq(feedbackDismissals.userId, userId));
    // Maestro chats; chat_messages cascade from the conversation.
    await tx.delete(conversations).where(eq(conversations.userId, userId));
    await tx
      .delete(adminLoginChallenges)
      .where(eq(adminLoginChallenges.userId, userId));
    // The bell.
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    // A connect link still open would let a client attach channels in the
    // deleted person's name; expired and revoked ones are history.
    await tx
      .delete(channelConnectLinks)
      .where(
        and(
          eq(channelConnectLinks.createdByUserId, userId),
          isNull(channelConnectLinks.revokedAt),
          gt(channelConnectLinks.expiresAt, now),
        ),
      );
    // Not in the brief's table (found by the FK audit): the person's own
    // unfinished ad wizard state, and their in-flight OAuth states.
    await tx.delete(adDrafts).where(eq(adDrafts.userId, userId));
    await tx.delete(oauthStates).where(eq(oauthStates.userId, userId));
    // The person's DM with the bot (spec: "telegram_bindings/bridge links").
    // A group binding belongs to the workspace and stays.
    await tx
      .delete(telegramChatBindings)
      .where(
        and(
          eq(telegramChatBindings.boundByWorkspaceUserId, userId),
          eq(telegramChatBindings.chatType, 'private'),
        ),
      );

    const present = await existingTables(tx, PUSH_ONLY_TABLES);
    if (present.has('maestro_channel_links')) {
      await tx
        .delete(maestroChannelLinks)
        .where(eq(maestroChannelLinks.userId, userId));
    }
    if (present.has('maestro_bridge_threads')) {
      await tx
        .delete(maestroBridgeThreads)
        .where(eq(maestroBridgeThreads.userId, userId));
    }
    if (present.has('canva_connections')) {
      // The person's own Canva OAuth grant.
      await tx
        .delete(canvaConnections)
        .where(eq(canvaConnections.userId, userId));
    }
  }
}

/**
 * The workspaces this person owns, which block the delete.
 *
 * The one place "owns a workspace" is decided for account delete. When
 * workspace soft delete lands, add `isNull(workspace.deletedAt)` to the
 * `where` below (a soft-deleted workspace no longer blocks).
 */
async function ownedWorkspaces(
  db: Executor,
  userId: string,
): Promise<OwnedWorkspace[]> {
  return db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(and(eq(workspace.ownerId, userId)))
    .orderBy(workspace.name, workspace.id);
}

/** Which of `names` exist in the current schema. */
async function existingTables(
  tx: Tx,
  names: readonly string[],
): Promise<Set<string>> {
  const rows = sql.join(
    names.map((n) => sql`(${n})`),
    sql`, `,
  );
  const result = await tx.execute<{ name: string }>(
    sql`SELECT t.name FROM (VALUES ${rows}) AS t(name) WHERE to_regclass(t.name) IS NOT NULL`,
  );
  return new Set(result.rows.map((r) => r.name));
}

function emailMismatch(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'EMAIL_MISMATCH',
    message: "That email doesn't match your account.",
  });
}

function ownsWorkspaces(workspaces: OwnedWorkspace[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'OWNS_WORKSPACES',
    message: 'You own workspaces. Delete them first.',
    workspaces,
  });
}

function billingCancelFailed(): BadGatewayException {
  return new BadGatewayException({
    statusCode: 502,
    error: 'Bad Gateway',
    code: 'BILLING_CANCEL_FAILED',
    message:
      "We couldn't cancel your subscription, so nothing was deleted. Try again in a few minutes.",
  });
}
