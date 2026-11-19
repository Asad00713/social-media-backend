import {
  ForbiddenException,
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
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
  stripeCustomers,
  telegramChatBindings,
  users,
  workspace,
  workspaceInvitation,
} from '../drizzle/schema';
import { SubscriptionService } from '../billing/services/subscription.service';
import { UsageService } from '../billing/services/usage.service';
import {
  avatarKeyFolder,
  CloudflareR2Service,
} from '../media/cloudflare-r2.service';
import { normalizeEmail } from './normalize-email';
import { liveWorkspaces } from '../posts/soft-delete/soft-delete';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';

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

/**
 * The address a deleted account is left with: unique per account, and on a
 * reserved TLD that can never receive mail, so the old address is free to
 * register again. Also written over the person's invitation rows.
 */
export function anonymisedEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

/** A membership the delete moved to REMOVED, as it was before. */
interface RemovedMembership {
  workspaceId: string;
  role: 'ADMIN' | 'MEMBER' | 'GUEST';
  status: 'ACCEPTED' | 'PENDING';
}

/** What the transaction hands to the after-commit cleanup. */
interface DeletionOutcome {
  /** Workspaces whose member count dropped: ACCEPTED, non-GUEST rows only. */
  seatWorkspaces: string[];
  /** The avatar the row pointed at, deleted from R2 after commit. */
  avatarUrl: string | null;
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
 *  4. After commit, best effort: each workspace where the person held a
 *     seat gets its member count decremented (as a normal member removal
 *     does), and their current avatar object is deleted from R2.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
    private readonly r2: CloudflareR2Service,
    // Last two: positional specs construct this service directly. Not
    // @Optional - both modules are global and always provide them; optional
    // in the type only so a spec that never deletes can leave them out.
    private readonly notificationsGateway?: NotificationsGateway,
    private readonly realtime?: AnalyticsEventEmitter,
  ) {}

  async deleteAccount(
    userId: string,
    input: DeleteAccountInput,
  ): Promise<void> {
    const [user] = await this.db
      .select({
        email: users.email,
        deletedAt: users.deletedAt,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    // Already deleted (an admin retry): nothing left to do.
    if (user.deletedAt) return;

    // DELETE /users/:id never takes out a platform super admin: one admin
    // must not be able to remove another (or the last one) from the admin
    // tool. Their own DELETE /users/me, with the typed email, is unchanged.
    if (input.actor === 'super_admin' && user.role === 'SUPER_ADMIN') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'SUPER_ADMIN_NOT_DELETABLE',
        message: 'A super admin account cannot be deleted from the admin tool.',
      });
    }

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
        // Already cancelled / no such subscription at the provider: nothing
        // bills, so the delete goes on.
        goneIsCancelled: true,
      });
    } catch (error) {
      this.logger.error(
        `Account delete ${userId}: billing cancel failed, nothing changed: ${(error as Error)?.message}`,
      );
      throw billingCancelFailed();
    }

    const outcome = await this.db.transaction((tx) =>
      this.deleteInTransaction(tx, userId, input),
    );
    if (!outcome) return;

    // After commit: the open tabs of the deleted account lose their live
    // sockets now, not at their next reconnect (which the gateways then
    // refuse). This instance only; a socket on another instance is refused
    // at its next connect.
    this.disconnectSockets(userId);

    await this.deleteAvatar(userId, outcome.avatarUrl);
  }

  /** Never throws: the account is already deleted. */
  private disconnectSockets(userId: string): void {
    try {
      this.notificationsGateway?.disconnectUser(userId);
    } catch (error) {
      this.logger.warn(
        `Account delete ${userId}: notification sockets not closed: ${(error as Error)?.message}`,
      );
    }
    this.realtime?.disconnectUser(userId);
  }

  /**
   * Deletes the one object the avatar URL names, never a prefix: the
   * `avatars/<12 chars>/` folder is not guaranteed unique per user. Only a URL
   * that is really one of our avatar keys AND sits in this person's own
   * folder is touched: anyone can set their avatar to someone else's URL, and
   * deleting their account must not delete the other person's picture. Older
   * avatars the person replaced earlier are left to the orphan sweep. Never
   * throws.
   */
  private async deleteAvatar(
    userId: string,
    avatarUrl: string | null,
  ): Promise<void> {
    if (!avatarUrl || !this.r2.isOwnPublicUrl(avatarUrl, 'avatar')) return;
    const key = this.r2.keyFromPublicUrl(avatarUrl);
    if (!key || !key.startsWith(avatarKeyFolder(userId))) return;
    try {
      await this.r2.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Account delete ${userId}: avatar object not deleted: ${(error as Error)?.message}`,
      );
    }
  }

  /**
   * Everything that changes rows. Returns what the after-commit cleanup
   * needs, or null when a concurrent delete got there first.
   */
  private async deleteInTransaction(
    tx: Tx,
    userId: string,
    input: DeleteAccountInput,
  ): Promise<DeletionOutcome | null> {
    // FOR UPDATE serialises two deletes of the same account, and blocks a
    // workspace insert naming this owner (its FK check takes KEY SHARE on
    // this row) until we commit.
    const [locked] = await tx
      .select({
        email: users.email,
        deletedAt: users.deletedAt,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!locked || locked.deletedAt) return null;

    // Again under the lock: a workspace created since the first check.
    const ownedNow = await ownedWorkspaces(tx, userId);
    if (ownedNow.length > 0) throw ownsWorkspaces(ownedNow);

    const now = new Date();
    const removed = await this.removeMemberships(tx, userId, locked.email, now);
    await this.deletePersonalRows(tx, userId, now);

    // The address must not survive next to the user id anywhere: billing
    // rows are kept for history, but not the email on them.
    await tx
      .update(stripeCustomers)
      .set({ email: null })
      .where(eq(stripeCustomers.userId, userId));

    await tx
      .update(users)
      .set({
        email: anonymisedEmail(userId),
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
        // Admin free text that often names the person.
        suspensionNote: null,
        isActive: false,
        deletedAt: now,
        // Every token minted before now is refused; the strategies also
        // refuse ACCOUNT_DELETED outright, whatever the token's iat.
        sessionsRevokedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    // The audit trail is kept (who did what, by id), but not the address or
    // name it recorded about this person: `actor_email` on what they did as
    // an admin, `target_label` (often their email or name) on what was done
    // to them. Before the insert below, which carries neither.
    await tx
      .update(adminAuditLogs)
      .set({ actorEmail: null })
      .where(eq(adminAuditLogs.actorId, userId));
    await tx
      .update(adminAuditLogs)
      .set({ targetLabel: null })
      .where(eq(adminAuditLogs.targetId, userId));

    // No PII: ids only, never the old email or name.
    await tx.insert(adminAuditLogs).values({
      action: input.actor === 'self' ? 'user.self_delete' : 'user.admin_delete',
      actorId: input.actorId,
      actorEmail: null,
      targetType: 'user',
      targetId: userId,
      targetLabel: null,
    });

    // A guest holds no seat (members_count counts ADMIN and MEMBER), and a
    // PENDING row never did. Guests are still REMOVED above. On `tx` (the
    // counter is transaction-aware): the freed seats commit with the delete,
    // or nothing does - never a delete whose seats stay taken, nor seats
    // freed for memberships a rolled-back delete kept.
    //
    // SORTED: the UPDATE ... RETURNING above yields workspaces in plan order,
    // and each decrement locks that workspace's usage row until commit. Two
    // concurrent deletes of people sharing workspaces would otherwise lock
    // W1 then W2 against W2 then W1 (deadlock); one fixed order cannot.
    const seatWorkspaces = [
      ...new Set(
        removed
          .filter((r) => r.status === 'ACCEPTED' && r.role !== 'GUEST')
          .map((r) => r.workspaceId),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const workspaceId of seatWorkspaces) {
      await this.usage.decrementMemberCount(workspaceId, userId, userId, tx);
    }

    return { seatWorkspaces, avatarUrl: locked.avatarUrl };
  }

  /**
   * Every ACCEPTED or PENDING membership -> REMOVED, by this person
   * (`removed_by = user` means "left on their own", never restorable), in ONE
   * UPDATE. A PENDING invitation also matches by email: one sent before the
   * account existed has no user_id. One statement, so an invite accepted
   * concurrently cannot slip between an ACCEPTED pass and a PENDING pass: the
   * row lock re-evaluates the newest version, and `old_status` is what the
   * row was when this statement took it.
   *
   * Each matched row also gets the anonymised email and a fresh token (as a
   * normal removal does). Afterwards every other invitation row of this user
   * (earlier REMOVED, REJECTED, EXPIRED) is anonymised too, so the old
   * address never survives next to the user id. Invitations the person SENT
   * are untouched (invited_by stays; it is SET NULL only on a hard delete).
   */
  private async removeMemberships(
    tx: Tx,
    userId: string,
    email: string,
    now: Date,
  ): Promise<RemovedMembership[]> {
    const anon = anonymisedEmail(userId);
    const wi = workspaceInvitation;
    const result = await tx.execute<{
      workspace_id: string;
      role: RemovedMembership['role'];
      old_status: RemovedMembership['status'];
    }>(sql`
      UPDATE workspace_invitations AS wi
         SET status = 'REMOVED',
             removed_at = ${now},
             removed_by = ${userId},
             email = ${anon},
             token = replace(gen_random_uuid()::text, '-', '')
                     || replace(gen_random_uuid()::text, '-', ''),
             updated_at = now()
        FROM (
          SELECT id, status AS old_status
            FROM workspace_invitations
           WHERE status IN ('ACCEPTED', 'PENDING')
             AND (user_id = ${userId}
                  OR (status = 'PENDING'
                      AND lower(email) = ${normalizeEmail(email)}))
             FOR UPDATE
        ) AS old
       WHERE wi.id = old.id
      RETURNING wi.workspace_id, wi.role, old.old_status`);

    await tx
      .update(wi)
      .set({ email: anon, updatedAt: now })
      .where(and(eq(wi.userId, userId), ne(wi.email, anon)));

    return result.rows.map((r) => ({
      workspaceId: r.workspace_id,
      role: r.role,
      status: r.old_status,
    }));
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
 * The one place "owns a workspace" is decided for account delete. A
 * soft-deleted workspace (migration 0088) no longer blocks: it is gone, its
 * posts are kept from publishing by liveWorkspacePosts() on every publish
 * path, and WorkspacePurgeService removes it after 30 days. The owner row
 * that RESTRICT (0095) protects is anonymised, never removed, so the purge
 * still finds it.
 */
async function ownedWorkspaces(
  db: Executor,
  userId: string,
): Promise<OwnedWorkspace[]> {
  return db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(and(eq(workspace.ownerId, userId), liveWorkspaces()))
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
