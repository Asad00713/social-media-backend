import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  eq,
  sql,
  asc,
  count,
  sum,
  and,
  gt,
  gte,
  lte,
  desc,
  ilike,
  inArray,
  isNull,
  isNotNull,
  or,
  notInArray,
} from 'drizzle-orm';
import { INTEGRATION_PLATFORMS } from '../drizzle/schema';
import {
  users,
  workspace,
  socialMediaChannels,
  posts,
  subscriptions,
  subscriptionItems,
  invoices,
  failedPayments,
  stripeCustomers,
  plans,
  addonPricing,
  aiUsageLog,
  workspaceUsage,
  workspaceInvitation,
  mediaItems,
} from '../drizzle/schema';
import { POST_STATUSES, type PostStatus } from '../drizzle/schema';

// Suspension reasons
export const SUSPENSION_REASONS = [
  'non_payment',
  'policy_violation',
  'abuse',
  'user_request',
  'inactivity',
  'manual',
] as const;

export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/**
 * What an operator sees in the status column.
 *
 * Not a stored column — `workspace` only has `isActive`. The distinction that
 * matters is *who* switched the account off: the inactivity sweep leaves
 * `suspendedReason: 'inactivity'`, everything else is a human decision. Those
 * two need different handling (one is reversible by the customer coming back,
 * the other is not) and lumping them together as "suspended" hides that.
 */
export const WORKSPACE_STATES = [
  'active',
  'deactivated',
  'suspended',
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/**
 * A user's three states, derived from two flags rather than stored. A user is
 * `active` once their email is verified, `unverified` while it is not, and
 * `suspended` when an admin has switched the account off — the last takes
 * precedence, since a suspended account's verification status is moot.
 */
export const USER_STATES = ['active', 'unverified', 'suspended'] as const;

export type UserState = (typeof USER_STATES)[number];

export function deriveUserState(
  isActive: boolean,
  isEmailVerified: boolean,
): UserState {
  if (!isActive) return 'suspended';
  return isEmailVerified ? 'active' : 'unverified';
}

export function deriveWorkspaceState(
  isActive: boolean,
  suspendedReason: string | null,
): WorkspaceState {
  if (isActive) return 'active';
  return suspendedReason === 'inactivity' ? 'deactivated' : 'suspended';
}

/**
 * The subscription lifecycle states Stripe writes onto `subscriptions.status`.
 * Not stored as an enum on the column (it is a plain varchar), so the admin
 * layer names the set it filters by.
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'past_due',
  'canceled',
  'trialing',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The invoice states Stripe mirrors onto `invoices.status`. */
export const INVOICE_STATUSES = [
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Columns the list may be ordered by. Anything else falls back to createdAt. */
export const WORKSPACE_SORT_FIELDS = [
  'name',
  'createdAt',
  'channelsCount',
  'membersCount',
  'aiTokensUsedThisMonth',
  'lifetimeRevenueCents',
] as const;

export type WorkspaceSortField = (typeof WORKSPACE_SORT_FIELDS)[number];

/**
 * Which resource a workspace has run out of. `any` is the one an operator
 * reaches for first — "who is about to need a bigger plan" rarely cares which
 * limit they hit.
 */
export const WORKSPACE_LIMIT_FILTERS = [
  'any',
  'channels',
  'members',
  'aiTokens',
] as const;

export type WorkspaceLimitFilter = (typeof WORKSPACE_LIMIT_FILTERS)[number];

/**
 * `none` is separate from `healthy` on purpose. A workspace with no channels
 * has nothing broken, but calling it healthy would bury the accounts that
 * actually publish under ones that never set anything up.
 */
export const WORKSPACE_CHANNEL_HEALTH_FILTERS = [
  'healthy',
  'needs_attention',
  'none',
] as const;

export type WorkspaceChannelHealthFilter =
  (typeof WORKSPACE_CHANNEL_HEALTH_FILTERS)[number];

@Injectable()
export class AdminService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  // ==========================================================================
  // Dashboard Overview Stats
  // ==========================================================================

  async getDashboardOverview() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Run all stats queries in parallel
    const [
      totalUsers,
      activeUsers,
      newUsersLast30Days,
      totalWorkspaces,
      activeWorkspaces,
      totalChannels,
      connectedChannels,
      totalPosts,
      publishedPosts,
      scheduledPosts,
      failedPosts,
    ] = await Promise.all([
      // Total users
      this.db.select({ count: count() }).from(users),
      // Active users (not suspended)
      this.db
        .select({ count: count() })
        .from(users)
        .where(eq(users.isActive, true)),
      // New users in last 30 days
      this.db
        .select({ count: count() })
        .from(users)
        .where(gte(users.createdAt, thirtyDaysAgo)),
      // Total workspaces
      this.db.select({ count: count() }).from(workspace),
      // Active workspaces (not suspended)
      this.db
        .select({ count: count() })
        .from(workspace)
        .where(eq(workspace.isActive, true)),
      // Total channels
      this.db.select({ count: count() }).from(socialMediaChannels),
      // Connected channels
      this.db
        .select({ count: count() })
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.connectionStatus, 'connected')),
      // Total posts
      this.db.select({ count: count() }).from(posts),
      // Published posts
      this.db
        .select({ count: count() })
        .from(posts)
        .where(eq(posts.status, 'published')),
      // Scheduled posts
      this.db
        .select({ count: count() })
        .from(posts)
        .where(eq(posts.status, 'scheduled')),
      // Failed posts
      this.db
        .select({ count: count() })
        .from(posts)
        .where(eq(posts.status, 'failed')),
    ]);

    return {
      users: {
        total: totalUsers[0]?.count || 0,
        active: activeUsers[0]?.count || 0,
        suspended: (totalUsers[0]?.count || 0) - (activeUsers[0]?.count || 0),
        newLast30Days: newUsersLast30Days[0]?.count || 0,
      },
      workspaces: {
        total: totalWorkspaces[0]?.count || 0,
        active: activeWorkspaces[0]?.count || 0,
        suspended:
          (totalWorkspaces[0]?.count || 0) - (activeWorkspaces[0]?.count || 0),
      },
      channels: {
        total: totalChannels[0]?.count || 0,
        connected: connectedChannels[0]?.count || 0,
        disconnected:
          (totalChannels[0]?.count || 0) - (connectedChannels[0]?.count || 0),
      },
      posts: {
        total: totalPosts[0]?.count || 0,
        published: publishedPosts[0]?.count || 0,
        scheduled: scheduledPosts[0]?.count || 0,
        failed: failedPosts[0]?.count || 0,
      },
    };
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  async getUsers(options: {
    page?: number;
    limit?: number;
    search?: string;
    isActive?: boolean;
    /**
     * The three states the UI shows, derived rather than stored: `active` and
     * `unverified` are both `isActive = true` split on whether the email was
     * confirmed, and `suspended` is `isActive = false`. Kept alongside the raw
     * `isActive` flag, which callers other than the admin table still pass.
     */
    state?: UserState;
    role?: string;
  }) {
    const { page = 1, limit = 20, search, isActive, state, role } = options;
    const offset = (page - 1) * limit;

    // Every filter, search included, goes into the WHERE clause. Search used
    // to run in JS after the page was fetched — the note said drizzle made
    // ILIKE awkward, but it exports `ilike` — so it only searched the twenty
    // rows already on screen and found nothing beyond page one.
    const conditions: any[] = [];
    if (isActive !== undefined) {
      conditions.push(eq(users.isActive, isActive));
    }
    if (state === 'suspended') {
      conditions.push(eq(users.isActive, false));
    } else if (state === 'active') {
      conditions.push(
        and(eq(users.isActive, true), eq(users.isEmailVerified, true)),
      );
    } else if (state === 'unverified') {
      conditions.push(
        and(eq(users.isActive, true), eq(users.isEmailVerified, false)),
      );
    }
    if (role) {
      conditions.push(eq(users.role, role as any));
    }
    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(or(ilike(users.email, term), ilike(users.name, term)));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [usersList, totalCount] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          isEmailVerified: users.isEmailVerified,
          isActive: users.isActive,
          suspendedAt: users.suspendedAt,
          suspendedReason: users.suspendedReason,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          // How many workspaces this user owns. A correlated subquery rather
          // than a join: a user owns many workspaces, so joining would repeat
          // the user row per workspace and inflate both the page and its count.
          //
          // `users.id` is written out as a qualified identifier on purpose. In
          // a single-table select Drizzle emits it bare as `"id"`, which the
          // subquery reads as `owned_ws.id` — an uncorrelated comparison that
          // matches nothing and counts zero for everyone. Qualifying it ties
          // the correlation back to the outer row.
          workspaceCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM ${workspace} AS owned_ws
            WHERE owned_ws.owner_id = ${sql.identifier('users')}.${sql.identifier('id')}
          )`.mapWith(Number),
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
      // Counted against the same WHERE — the old count ignored every filter,
      // so filtering to suspended users still advertised the full user count.
      this.db.select({ count: count() }).from(users).where(where),
    ]);

    const total = totalCount[0]?.count ?? 0;

    return {
      users: usersList,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUserById(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        name: true,
        role: true,
        isEmailVerified: true,
        isActive: true,
        suspendedAt: true,
        suspendedReason: true,
        suspensionNote: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get user's workspaces
    const userWorkspaces = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        isActive: workspace.isActive,
        createdAt: workspace.createdAt,
      })
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    return {
      ...user,
      workspaces: userWorkspaces,
    };
  }

  async suspendUser(
    userId: string,
    adminId: string,
    reason: SuspensionReason,
    note?: string,
  ) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === 'SUPER_ADMIN') {
      throw new BadRequestException('Cannot suspend a super admin');
    }

    if (!user.isActive) {
      throw new BadRequestException('User is already suspended');
    }

    const [updatedUser] = await this.db
      .update(users)
      .set({
        isActive: false,
        suspendedAt: new Date(),
        suspendedReason: reason,
        suspendedById: adminId,
        suspensionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    return {
      success: true,
      message: `User ${user.email} has been suspended`,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        isActive: updatedUser.isActive,
        suspendedAt: updatedUser.suspendedAt,
        suspendedReason: updatedUser.suspendedReason,
      },
    };
  }

  async reactivateUser(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isActive) {
      throw new BadRequestException('User is not suspended');
    }

    await this.db.execute(sql`
      UPDATE users
      SET
        is_active = true,
        suspended_at = NULL,
        suspended_reason = NULL,
        suspended_by_id = NULL,
        suspension_note = NULL,
        updated_at = ${new Date()}
      WHERE id = ${userId}
    `);

    return {
      success: true,
      message: `User ${user.email} has been reactivated`,
    };
  }

  // ==========================================================================
  // Workspace Management
  // ==========================================================================

  async getWorkspaces(options: {
    page?: number;
    limit?: number;
    search?: string;
    isActive?: boolean;
    state?: WorkspaceState;
    planCode?: string;
    hasRevenue?: boolean;
    atLimit?: WorkspaceLimitFilter;
    channelHealth?: WorkspaceChannelHealthFilter;
    createdAfter?: Date;
    createdBefore?: Date;
    sortBy?: WorkspaceSortField;
    sortOrder?: 'asc' | 'desc';
  }) {
    const {
      page = 1,
      limit = 20,
      search,
      isActive,
      state,
      planCode,
      hasRevenue,
      atLimit,
      channelHealth,
      createdAfter,
      createdBefore,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;
    const offset = (page - 1) * limit;

    // Search and filters both belong in the WHERE clause. Search used to run
    // in JS *after* the page had been fetched, which meant it only ever looked
    // at the twenty rows already on screen — searching for a workspace sitting
    // on page three returned nothing at all. Matching the owner's email is why
    // the join is here rather than in a second pass.
    const conditions: any[] = [];
    if (isActive !== undefined) {
      conditions.push(eq(workspace.isActive, isActive));
    }

    // `state` is derived, not stored. There is no `deactivated` column — an
    // account switched off by the inactivity sweep and one switched off by a
    // human are the same two columns with a different reason, so the
    // distinction has to be reconstructed here rather than read.
    if (state === 'active') {
      conditions.push(eq(workspace.isActive, true));
    } else if (state === 'deactivated') {
      conditions.push(
        and(
          eq(workspace.isActive, false),
          eq(workspace.suspendedReason, 'inactivity'),
        ),
      );
    } else if (state === 'suspended') {
      conditions.push(
        and(
          eq(workspace.isActive, false),
          // `ne` would drop rows where the reason is null, and a workspace
          // switched off without one is still suspended.
          or(
            isNull(workspace.suspendedReason),
            sql`${workspace.suspendedReason} <> 'inactivity'`,
          ),
        ),
      );
    }

    if (planCode) {
      conditions.push(eq(subscriptions.planCode, planCode));
    }

    // Paying or not. `hasRevenue` is deliberately a boolean rather than a
    // min/max pair: the useful cut is between customers who have given us
    // money and ones who never have, and an amount range invites a precision
    // this data does not have (a workspace on its first month and one three
    // years in are not comparable by total).
    if (hasRevenue !== undefined) {
      const paidAnything = sql`EXISTS (
        SELECT 1 FROM ${invoices}
        INNER JOIN ${subscriptions} AS rev_sub
          ON rev_sub.id = ${invoices.subscriptionId}
        WHERE rev_sub.workspace_id = ${workspace.id}
          AND ${invoices.status} = 'paid'
          AND ${invoices.amountPaidCents} > 0
      )`;
      conditions.push(hasRevenue ? paidAnything : sql`NOT ${paidAnything}`);
    }

    // At or over a plan limit — the upgrade conversation, in other words.
    // Compares against base plus purchased add-ons, because a workspace that
    // bought two extra channels is not at its limit until it fills those too.
    if (atLimit) {
      // Each resource carries its own `limit > 0` guard, and it has to be its
      // own rather than a check on the workspace as a whole.
      //
      // A limit of 0 means unlimited or not yet set, never "full". On a free
      // plan `ai_tokens_limit` is 0 while channels are capped at 3, so a
      // workspace-wide guard passes on the channel limit and then matches
      // `0 tokens >= 0 limit` — reporting a brand-new empty workspace as
      // being at its limit. That is exactly backwards from what this filter
      // is for.
      // `AnyPgColumn` because Drizzle gives every column its own literal type
      // — naming one of them here would pin the helper to that single column.
      const full = (
        used: AnyPgColumn,
        base: AnyPgColumn,
        extra: AnyPgColumn,
      ) => sql`(
        (COALESCE(${base}, 0) + COALESCE(${extra}, 0)) > 0
        AND ${used} >= (COALESCE(${base}, 0) + COALESCE(${extra}, 0))
      )`;

      const channelsFull = full(
        workspaceUsage.channelsCount,
        workspaceUsage.channelsLimit,
        workspaceUsage.extraChannelsPurchased,
      );
      const membersFull = full(
        workspaceUsage.membersCount,
        workspaceUsage.membersLimit,
        workspaceUsage.extraMembersPurchased,
      );
      const tokensFull = full(
        workspaceUsage.aiTokensUsedThisMonth,
        workspaceUsage.aiTokensLimit,
        workspaceUsage.extraAiTokensPurchased,
      );

      const limitCondition =
        atLimit === 'channels'
          ? channelsFull
          : atLimit === 'members'
            ? membersFull
            : atLimit === 'aiTokens'
              ? tokensFull
              : or(channelsFull, membersFull, tokensFull);

      conditions.push(
        // A workspace with no usage row has consumed nothing at all.
        and(isNotNull(workspaceUsage.workspaceId), limitCondition),
      );
    }

    // Channels that will not publish. Worth its own filter because nothing
    // else surfaces it: the customer sees failures, we see a healthy-looking
    // workspace until someone opens it.
    if (channelHealth === 'needs_attention') {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${socialMediaChannels}
        WHERE ${socialMediaChannels.workspaceId} = ${workspace.id}
          AND (
            ${socialMediaChannels.connectionStatus} <> 'connected'
            OR ${socialMediaChannels.isActive} = false
          )
      )`);
    } else if (channelHealth === 'healthy') {
      // Has channels, and none of them broken. A workspace with no channels
      // at all is not "healthy" — it has nothing to be healthy about, and
      // including it would bury the accounts this filter is asking after.
      conditions.push(sql`(
        EXISTS (
          SELECT 1 FROM ${socialMediaChannels}
          WHERE ${socialMediaChannels.workspaceId} = ${workspace.id}
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${socialMediaChannels}
          WHERE ${socialMediaChannels.workspaceId} = ${workspace.id}
            AND (
              ${socialMediaChannels.connectionStatus} <> 'connected'
              OR ${socialMediaChannels.isActive} = false
            )
        )
      )`);
    } else if (channelHealth === 'none') {
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM ${socialMediaChannels}
        WHERE ${socialMediaChannels.workspaceId} = ${workspace.id}
      )`);
    }

    if (createdAfter) {
      conditions.push(gte(workspace.createdAt, createdAfter));
    }

    if (createdBefore) {
      conditions.push(lte(workspace.createdAt, createdBefore));
    }

    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(
        or(
          ilike(workspace.name, term),
          ilike(workspace.slug, term),
          ilike(users.email, term),
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Whitelisted, never interpolated. `sortBy` arrives from a query string,
    // and handing that to the ORM as a column name is how an order clause
    // turns into an injection point.
    const SORTABLE = {
      name: workspace.name,
      createdAt: workspace.createdAt,
      channelsCount: workspaceUsage.channelsCount,
      membersCount: workspaceUsage.membersCount,
      aiTokensUsedThisMonth: workspaceUsage.aiTokensUsedThisMonth,
      // Repeats the subquery in the selected column rather than referring to
      // its alias: Postgres will not accept a select alias in ORDER BY here,
      // and it plans the two occurrences as one anyway.
      lifetimeRevenueCents: sql`(
        SELECT COALESCE(SUM(${invoices.amountPaidCents}), 0)
        FROM ${invoices}
        INNER JOIN ${subscriptions} AS sort_sub
          ON sort_sub.id = ${invoices.subscriptionId}
        WHERE sort_sub.workspace_id = ${workspace.id}
          AND ${invoices.status} = 'paid'
      )`,
    } as const;
    const sortColumn = SORTABLE[sortBy] ?? workspace.createdAt;
    const orderBy = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

    // One join instead of a query per row. The old code fetched owners in a
    // loop, so a page of twenty workspaces cost twenty-one round trips.
    //
    // `workspace_usage` carries counts *and* the limits they are measured
    // against, which is the difference between "7 channels" and "7 of 10" —
    // the second one says whether this customer is about to need a bigger
    // plan. Left-joined because a workspace that has never been calculated
    // has no row, and it should still appear in the list.
    const rows = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        isActive: workspace.isActive,
        suspendedAt: workspace.suspendedAt,
        suspendedReason: workspace.suspendedReason,
        ownerId: workspace.ownerId,
        createdAt: workspace.createdAt,
        ownerEmail: users.email,
        ownerName: users.name,
        channelsCount: workspaceUsage.channelsCount,
        channelsLimit: workspaceUsage.channelsLimit,
        extraChannelsPurchased: workspaceUsage.extraChannelsPurchased,
        membersCount: workspaceUsage.membersCount,
        membersLimit: workspaceUsage.membersLimit,
        extraMembersPurchased: workspaceUsage.extraMembersPurchased,
        aiTokensUsedThisMonth: workspaceUsage.aiTokensUsedThisMonth,
        aiTokensLimit: workspaceUsage.aiTokensLimit,
        extraAiTokensPurchased: workspaceUsage.extraAiTokensPurchased,
        planCode: subscriptions.planCode,
        subscriptionStatus: subscriptions.status,
        trialEnd: subscriptions.trialEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        // A subquery rather than another join. Invoices are many-per-
        // workspace, so joining them would multiply each workspace into one
        // row per invoice and every count on this page would inflate with it.
        //
        // COALESCE because a workspace that has never been billed sums to
        // NULL, and a list column reading "—" where it means "nothing yet"
        // is a distinction without a difference here.
        lifetimeRevenueCents: sql<number>`(
          SELECT COALESCE(SUM(${invoices.amountPaidCents}), 0)
          FROM ${invoices}
          INNER JOIN ${subscriptions} AS inv_sub
            ON inv_sub.id = ${invoices.subscriptionId}
          WHERE inv_sub.workspace_id = ${workspace.id}
            AND ${invoices.status} = 'paid'
        )`.mapWith(Number),
      })
      .from(workspace)
      .leftJoin(users, eq(users.id, workspace.ownerId))
      .leftJoin(workspaceUsage, eq(workspaceUsage.workspaceId, workspace.id))
      .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspace.id))
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Counted against the same WHERE and the same joins. The old count was of
    // the whole table, so any filter left the pagination claiming pages that
    // could not be opened.
    const totalCount = await this.db
      .select({ count: count() })
      .from(workspace)
      .leftJoin(users, eq(users.id, workspace.ownerId))
      .leftJoin(workspaceUsage, eq(workspaceUsage.workspaceId, workspace.id))
      .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspace.id))
      .where(where);

    const total = totalCount[0]?.count ?? 0;

    return {
      workspaces: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        isActive: row.isActive,
        suspendedAt: row.suspendedAt,
        suspendedReason: row.suspendedReason,
        // Resolved once, on the server, so every screen reading this list
        // agrees on what "suspended" means.
        state: deriveWorkspaceState(row.isActive, row.suspendedReason),
        ownerId: row.ownerId,
        createdAt: row.createdAt,
        owner: row.ownerId
          ? { id: row.ownerId, email: row.ownerEmail, name: row.ownerName }
          : null,
        usage: this.shapeUsage(row),
        // Cents, like everywhere else money appears in this API.
        lifetimeRevenueCents: row.lifetimeRevenueCents ?? 0,
        subscription: row.planCode
          ? {
              planCode: row.planCode,
              status: row.subscriptionStatus,
              trialEnd: row.trialEnd,
              cancelAtPeriodEnd: row.cancelAtPeriodEnd,
              currentPeriodEnd: row.currentPeriodEnd,
            }
          : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Turns a `workspace_usage` row into used/limit pairs.
   *
   * The limit is base plus whatever was bought on top, and that sum is the
   * only number an operator can act on — a workspace sitting at 5 of 3 looks
   * like a bug until you know two extra channels were purchased. Shared by
   * the list and the detail view so the two can never disagree about it.
   *
   * A workspace with no usage row reads as zero of zero rather than null:
   * the row is created lazily, and its absence means nothing has been used.
   */
  private shapeUsage(
    usage: {
      channelsCount?: number | null;
      channelsLimit?: number | null;
      extraChannelsPurchased?: number | null;
      membersCount?: number | null;
      membersLimit?: number | null;
      extraMembersPurchased?: number | null;
      aiTokensUsedThisMonth?: number | null;
      aiTokensLimit?: number | null;
      extraAiTokensPurchased?: number | null;
    } | null | undefined,
  ) {
    return {
      channels: {
        used: usage?.channelsCount ?? 0,
        limit: (usage?.channelsLimit ?? 0) + (usage?.extraChannelsPurchased ?? 0),
      },
      members: {
        used: usage?.membersCount ?? 0,
        limit: (usage?.membersLimit ?? 0) + (usage?.extraMembersPurchased ?? 0),
      },
      aiTokens: {
        used: usage?.aiTokensUsedThisMonth ?? 0,
        limit:
          (usage?.aiTokensLimit ?? 0) + (usage?.extraAiTokensPurchased ?? 0),
      },
    };
  }

  async getWorkspaceById(workspaceId: string) {
    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    // Everything below is independent of everything else, so it goes out at
    // once rather than in sequence. Awaited one after another this endpoint
    // paid for seven round trips to open a single page.
    const [
      owner,
      suspendedBy,
      usage,
      subscription,
      channelList,
      postsByStatus,
      memberRows,
    ] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, ws.ownerId),
        columns: {
          id: true,
          email: true,
          name: true,
          lastLoginAt: true,
          isActive: true,
          createdAt: true,
        },
      }),

      // Who switched it off. A name here is the difference between "this was
      // a decision someone made" and "this happened".
      ws.suspendedById
        ? this.db.query.users.findFirst({
            where: eq(users.id, ws.suspendedById),
            columns: { id: true, email: true, name: true },
          })
        : Promise.resolve(null),

      this.db.query.workspaceUsage.findFirst({
        where: eq(workspaceUsage.workspaceId, workspaceId),
      }),

      this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.workspaceId, workspaceId),
      }),

      // The channels themselves, not a count. "3 channels" and "3 channels,
      // two of which stopped authenticating" are different situations, and
      // only the second one explains why a customer is complaining.
      this.db
        .select({
          id: socialMediaChannels.id,
          platform: socialMediaChannels.platform,
          accountName: socialMediaChannels.accountName,
          connectionStatus: socialMediaChannels.connectionStatus,
          tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
          isActive: socialMediaChannels.isActive,
        })
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.workspaceId, workspaceId)),

      this.db
        .select({ status: posts.status, count: count() })
        .from(posts)
        .where(eq(posts.workspaceId, workspaceId))
        .groupBy(posts.status),

      // Members are accepted invitations — there is no membership table, so
      // counting `workspace_usage.membersCount` alone would give a number
      // with nobody attached to it.
      this.db
        .select({
          id: workspaceInvitation.id,
          email: workspaceInvitation.email,
          role: workspaceInvitation.role,
          status: workspaceInvitation.status,
          acceptedAt: workspaceInvitation.acceptedAt,
          userId: workspaceInvitation.userId,
          userName: users.name,
        })
        .from(workspaceInvitation)
        .leftJoin(users, eq(users.id, workspaceInvitation.userId))
        .where(eq(workspaceInvitation.workspaceId, workspaceId)),
    ]);

    const acceptedMembers = memberRows.filter((m) => m.status === 'ACCEPTED');
    const pendingInvites = memberRows.filter((m) => m.status === 'PENDING');

    const now = new Date();
    const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

    const channelHealth = {
      total: channelList.length,
      connected: channelList.filter(
        (c) => c.connectionStatus === 'connected' && c.isActive,
      ).length,
      // Anything not cleanly connected: revoked, errored, disconnected.
      needsAttention: channelList.filter(
        (c) => c.connectionStatus !== 'connected' || !c.isActive,
      ).length,
      // A token that lapses next week is not broken yet, which is exactly
      // why it is worth surfacing now rather than after it breaks.
      expiringSoon: channelList.filter(
        (c) =>
          c.tokenExpiresAt !== null &&
          c.tokenExpiresAt.getTime() > now.getTime() &&
          c.tokenExpiresAt.getTime() - now.getTime() < EXPIRING_SOON_MS,
      ).length,
    };

    const postCounts = Object.fromEntries(
      postsByStatus.map((row) => [row.status, row.count]),
    ) as Record<string, number>;

    return {
      ...ws,
      state: deriveWorkspaceState(ws.isActive, ws.suspendedReason),
      owner,
      suspendedBy,
      usage: this.shapeUsage(usage),
      channels: channelList,
      channelHealth,
      members: acceptedMembers,
      pendingInvitations: pendingInvites,
      stats: {
        channelsCount: channelList.length,
        membersCount: acceptedMembers.length,
        pendingInvitationsCount: pendingInvites.length,
        postsCount: postsByStatus.reduce((sum, row) => sum + row.count, 0),
        postsByStatus: postCounts,
      },
      subscription: subscription
        ? {
            planCode: subscription.planCode,
            status: subscription.status,
            trialEnd: subscription.trialEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
    };
  }

  /**
   * What this workspace has paid us, and what it has consumed.
   *
   * Its own endpoint rather than more fields on the detail response: this is
   * one tab out of six, and the invoice history behind it grows every month.
   * Loading it to open the overview would make the common case pay for the
   * rare one.
   *
   * Money is reported in cents throughout. Dividing here would hand the
   * frontend a float to round a second time, and two roundings of the same
   * figure are how a total stops matching the rows above it.
   */
  /**
   * This workspace's posts, newest first, with per-channel outcomes.
   *
   * The reason a post failed lives inside the `targets` JSONB rather than in a
   * column: a post going to four channels can succeed on three and fail on
   * one, and the row's own `status` flattens that to
   * `partially_published`. An operator answering "why didn't this go out"
   * needs the channel and the message, so the targets are unpacked here.
   */
  async getWorkspacePosts(
    workspaceId: string,
    options: { page?: number; limit?: number; status?: PostStatus } = {},
  ) {
    const { page = 1, limit = 20, status } = options;
    const offset = (page - 1) * limit;

    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { id: true },
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    const where = status
      ? and(eq(posts.workspaceId, workspaceId), eq(posts.status, status))
      : eq(posts.workspaceId, workspaceId);

    const [rows, totalCount, statusCounts] = await Promise.all([
      this.db
        .select({
          id: posts.id,
          content: posts.content,
          status: posts.status,
          targets: posts.targets,
          mediaItems: posts.mediaItems,
          scheduledAt: posts.scheduledAt,
          publishedAt: posts.publishedAt,
          lastError: posts.lastError,
          createdAt: posts.createdAt,
          authorId: users.id,
          authorEmail: users.email,
          authorName: users.name,
        })
        .from(posts)
        .leftJoin(users, eq(users.id, posts.createdById))
        .where(where)
        .orderBy(desc(posts.createdAt))
        .limit(limit)
        .offset(offset),

      this.db.select({ count: count() }).from(posts).where(where),

      // Counted across the whole workspace, not the filtered page — these
      // drive the status tabs, which have to keep showing what is in the
      // other tabs.
      this.db
        .select({ status: posts.status, count: count() })
        .from(posts)
        .where(eq(posts.workspaceId, workspaceId))
        .groupBy(posts.status),
    ]);

    const total = totalCount[0]?.count ?? 0;

    return {
      posts: rows.map((row) => ({
        id: row.id,
        // Enough to recognise the post, not enough to read it here. The
        // admin dashboard is for triage; the full text is the customer's.
        excerpt: row.content ? row.content.slice(0, 200) : null,
        contentLength: row.content?.length ?? 0,
        status: row.status,
        scheduledAt: row.scheduledAt,
        publishedAt: row.publishedAt,
        createdAt: row.createdAt,
        lastError: row.lastError,
        mediaCount: row.mediaItems?.length ?? 0,
        author: row.authorId
          ? { id: row.authorId, email: row.authorEmail, name: row.authorName }
          : null,
        targets: (row.targets ?? []).map((target) => ({
          channelId: target.channelId,
          platform: target.platform,
          // The composer writes `publishStatus` while older rows carry
          // `status`. Reading only one silently reports every post from the
          // other era as having no outcome at all.
          status:
            (target as { publishStatus?: PostStatus }).publishStatus ??
            target.status,
          errorMessage: target.errorMessage ?? null,
          platformPostUrl: target.platformPostUrl ?? null,
          publishedAt: target.publishedAt ?? null,
        })),
      })),
      statusCounts: Object.fromEntries(
        statusCounts.map((row) => [row.status, row.count]),
      ) as Record<string, number>,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * What this workspace stores, and what it costs us to keep.
   *
   * Deleted items are counted separately rather than excluded. The recycle
   * bin still occupies real bytes on R2 and Cloudinary, and a workspace whose
   * storage is mostly deleted files is a different conversation from one
   * that is genuinely large.
   */
  async getWorkspaceMedia(
    workspaceId: string,
    options: { page?: number; limit?: number; includeDeleted?: boolean } = {},
  ) {
    const { page = 1, limit = 24, includeDeleted = false } = options;
    const offset = (page - 1) * limit;

    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { id: true },
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    const listWhere = includeDeleted
      ? eq(mediaItems.workspaceId, workspaceId)
      : and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, false),
        );

    const [rows, totalCount, byType, deletedTotals] = await Promise.all([
      this.db
        .select({
          id: mediaItems.id,
          name: mediaItems.name,
          type: mediaItems.type,
          thumbnailUrl: mediaItems.thumbnailUrl,
          mimeType: mediaItems.mimeType,
          fileSize: mediaItems.fileSize,
          width: mediaItems.width,
          height: mediaItems.height,
          duration: mediaItems.duration,
          usageCount: mediaItems.usageCount,
          lastUsedAt: mediaItems.lastUsedAt,
          isDeleted: mediaItems.isDeleted,
          createdAt: mediaItems.createdAt,
          // Which provider is holding the bytes. A Cloudinary public id means
          // it is on Cloudinary; everything else is on our own storage.
          cloudinaryPublicId: mediaItems.cloudinaryPublicId,
          uploaderEmail: users.email,
        })
        .from(mediaItems)
        .leftJoin(users, eq(users.id, mediaItems.uploadedById))
        .where(listWhere)
        .orderBy(desc(mediaItems.createdAt))
        .limit(limit)
        .offset(offset),

      this.db.select({ count: count() }).from(mediaItems).where(listWhere),

      this.db
        .select({
          type: mediaItems.type,
          count: count(),
          bytes: sum(mediaItems.fileSize),
        })
        .from(mediaItems)
        .where(
          and(
            eq(mediaItems.workspaceId, workspaceId),
            eq(mediaItems.isDeleted, false),
          ),
        )
        .groupBy(mediaItems.type),

      this.db
        .select({ count: count(), bytes: sum(mediaItems.fileSize) })
        .from(mediaItems)
        .where(
          and(
            eq(mediaItems.workspaceId, workspaceId),
            eq(mediaItems.isDeleted, true),
          ),
        ),
    ]);

    const total = totalCount[0]?.count ?? 0;

    const liveBytes = byType.reduce(
      (sum, row) => sum + Number(row.bytes ?? 0),
      0,
    );
    const liveCount = byType.reduce((sum, row) => sum + row.count, 0);
    const deletedBytes = Number(deletedTotals[0]?.bytes ?? 0);

    return {
      storage: {
        liveBytes,
        liveCount,
        deletedBytes,
        deletedCount: deletedTotals[0]?.count ?? 0,
        // What the provider bills for: everything still stored, bin included.
        totalBytes: liveBytes + deletedBytes,
        byType: byType
          .map((row) => ({
            type: row.type,
            count: row.count,
            bytes: Number(row.bytes ?? 0),
          }))
          .sort((a, b) => b.bytes - a.bytes),
      },
      media: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getWorkspaceBilling(workspaceId: string) {
    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { id: true },
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    // Invoices hang off the subscription, not the workspace — there is no
    // workspace_id on the table — so every invoice query here goes through
    // this join.
    const invoiceJoin = this.db
      .select({
        id: invoices.id,
        totalCents: invoices.totalCents,
        amountPaidCents: invoices.amountPaidCents,
        amountDueCents: invoices.amountDueCents,
        currency: invoices.currency,
        status: invoices.status,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        paidAt: invoices.paidAt,
        hostedInvoiceUrl: invoices.hostedInvoiceUrl,
        invoicePdfUrl: invoices.invoicePdfUrl,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
      .where(eq(subscriptions.workspaceId, workspaceId));

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const [invoiceRows, aiByOperation, aiRecent, failedPaymentRows] =
      await Promise.all([
        invoiceJoin.orderBy(desc(invoices.createdAt)).limit(24),

        // Where the tokens went. A single "693 used" figure says a workspace
        // is active; this says what it is active doing, which is the half
        // that tells you whether an upgrade would actually help them.
        this.db
          .select({
            operation: aiUsageLog.operation,
            tokens: sum(aiUsageLog.tokensUsed),
            calls: count(),
          })
          .from(aiUsageLog)
          .where(
            and(
              eq(aiUsageLog.workspaceId, workspaceId),
              gte(aiUsageLog.createdAt, startOfMonth),
            ),
          )
          .groupBy(aiUsageLog.operation),

        this.db
          .select({
            tokens: sum(aiUsageLog.tokensUsed),
            calls: count(),
          })
          .from(aiUsageLog)
          .where(
            and(
              eq(aiUsageLog.workspaceId, workspaceId),
              gte(aiUsageLog.createdAt, thirtyDaysAgo),
            ),
          ),

        // Unresolved only. A card that failed in March and went through on
        // the retry is history; a count that includes it reports a billing
        // problem at a workspace that does not have one.
        this.db
          .select({ count: count() })
          .from(failedPayments)
          .innerJoin(
            subscriptions,
            eq(subscriptions.id, failedPayments.subscriptionId),
          )
          .where(
            and(
              eq(subscriptions.workspaceId, workspaceId),
              eq(failedPayments.resolved, false),
            ),
          ),
      ]);

    const paid = invoiceRows.filter((row) => row.status === 'paid');

    // `open` and `uncollectible` are both money we invoiced and have not been
    // given. Counting only `open` would hide the invoices Stripe has already
    // given up on, which are the ones worth knowing about.
    const outstanding = invoiceRows.filter(
      (row) => row.status === 'open' || row.status === 'uncollectible',
    );

    const lifetimeCents = paid.reduce(
      (total, row) => total + row.amountPaidCents,
      0,
    );

    const last30DaysCents = paid
      .filter((row) => row.paidAt !== null && row.paidAt >= thirtyDaysAgo)
      .reduce((total, row) => total + row.amountPaidCents, 0);

    const outstandingCents = outstanding.reduce(
      (total, row) => total + row.amountDueCents,
      0,
    );

    return {
      earnings: {
        // Named for what it is: the sum of the invoices held here, not
        // necessarily every invoice ever issued. See `invoicesTruncated`.
        lifetimeCents,
        last30DaysCents,
        outstandingCents,
        // Every invoice on this workspace shares a currency in practice, but
        // reading it from the data beats hard-coding 'usd' into the UI.
        currency: invoiceRows[0]?.currency ?? 'usd',
        paidInvoiceCount: paid.length,
        outstandingInvoiceCount: outstanding.length,
        unresolvedFailedPayments: failedPaymentRows[0]?.count ?? 0,
      },
      // Says out loud that the totals above cover the rows below and no more.
      // A "lifetime" figure quietly computed from the latest 24 invoices
      // would be wrong for exactly the customers who matter most.
      invoicesTruncated: invoiceRows.length === 24,
      invoices: invoiceRows,
      consumption: {
        aiTokensLast30Days: Number(aiRecent[0]?.tokens ?? 0),
        aiCallsLast30Days: aiRecent[0]?.calls ?? 0,
        byOperation: aiByOperation
          .map((row) => ({
            operation: row.operation,
            tokens: Number(row.tokens ?? 0),
            calls: row.calls,
          }))
          .sort((a, b) => b.tokens - a.tokens),
      },
    };
  }

  /**
   * Suspends several workspaces, reporting each one's outcome.
   *
   * Sequential rather than a single UPDATE, and deliberately so: each row
   * goes through `suspendWorkspace`, which refuses one that is already
   * suspended and records who did it. A bulk UPDATE would be one query and
   * would silently overwrite the reason and author on rows that were already
   * switched off for something else.
   *
   * One failure does not stop the rest. Selecting twelve workspaces and
   * having the whole thing abort because the third was already suspended
   * would be worse than doing the other eleven and saying so.
   */
  async bulkSuspendWorkspaces(
    workspaceIds: string[],
    adminId: string,
    reason: SuspensionReason,
    note?: string,
  ) {
    const results: Array<{
      workspaceId: string;
      success: boolean;
      message?: string;
    }> = [];

    for (const workspaceId of workspaceIds) {
      try {
        await this.suspendWorkspace(workspaceId, adminId, reason, note);
        results.push({ workspaceId, success: true });
      } catch (error) {
        results.push({
          workspaceId,
          success: false,
          message:
            error instanceof Error ? error.message : 'Could not suspend',
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;

    return {
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }

  async bulkReactivateWorkspaces(workspaceIds: string[]) {
    const results: Array<{
      workspaceId: string;
      success: boolean;
      message?: string;
    }> = [];

    for (const workspaceId of workspaceIds) {
      try {
        await this.reactivateWorkspace(workspaceId);
        results.push({ workspaceId, success: true });
      } catch (error) {
        results.push({
          workspaceId,
          success: false,
          message:
            error instanceof Error ? error.message : 'Could not reactivate',
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;

    return {
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }

  async suspendWorkspace(
    workspaceId: string,
    adminId: string,
    reason: SuspensionReason,
    note?: string,
  ) {
    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    if (!ws.isActive) {
      throw new BadRequestException('Workspace is already suspended');
    }

    const [updatedWorkspace] = await this.db
      .update(workspace)
      .set({
        isActive: false,
        suspendedAt: new Date(),
        suspendedReason: reason,
        suspendedById: adminId,
        suspensionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, workspaceId))
      .returning();

    return {
      success: true,
      message: `Workspace "${ws.name}" has been suspended`,
      workspace: {
        id: updatedWorkspace.id,
        name: updatedWorkspace.name,
        isActive: updatedWorkspace.isActive,
        suspendedAt: updatedWorkspace.suspendedAt,
        suspendedReason: updatedWorkspace.suspendedReason,
      },
    };
  }

  async reactivateWorkspace(workspaceId: string) {
    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });

    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }

    if (ws.isActive) {
      throw new BadRequestException('Workspace is not suspended');
    }

    await this.db.execute(sql`
      UPDATE workspace
      SET
        is_active = true,
        suspended_at = NULL,
        suspended_reason = NULL,
        suspended_by_id = NULL,
        suspension_note = NULL,
        updated_at = ${new Date()}
      WHERE id = ${workspaceId}
    `);

    return {
      success: true,
      message: `Workspace "${ws.name}" has been reactivated`,
    };
  }

  // ==========================================================================
  // Channel Analytics
  // ==========================================================================

  async getChannelStats() {
    // Publishing channels only, matching the list — cloud/calendar
    // integrations share the table but are not channels and would inflate
    // every count here. By platform, not the `category` column, which is
    // unreliable until its backfill has run.
    const notIntegration = notInArray(
      socialMediaChannels.platform,
      INTEGRATION_PLATFORMS,
    );

    // Channels by platform
    const channelsByPlatform = await this.db
      .select({
        platform: socialMediaChannels.platform,
        count: count(),
      })
      .from(socialMediaChannels)
      .where(notIntegration)
      .groupBy(socialMediaChannels.platform)
      .orderBy(desc(count()));

    // Channels by status
    const channelsByStatus = await this.db
      .select({
        status: socialMediaChannels.connectionStatus,
        count: count(),
      })
      .from(socialMediaChannels)
      .where(notIntegration)
      .groupBy(socialMediaChannels.connectionStatus);

    // Broken count per platform, so the by-platform view can show how many of
    // each platform's channels need a reconnect without apportioning a
    // fleet-wide rate as a guess.
    const brokenByPlatform = await this.db
      .select({
        platform: socialMediaChannels.platform,
        count: count(),
      })
      .from(socialMediaChannels)
      .where(
        and(
          notIntegration,
          sql`${socialMediaChannels.connectionStatus} IN ('expired', 'error', 'revoked')`,
        ),
      )
      .groupBy(socialMediaChannels.platform);

    // Expired/error channels
    const problemChannels = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        connectionStatus: socialMediaChannels.connectionStatus,
        lastError: socialMediaChannels.lastError,
        lastErrorAt: socialMediaChannels.lastErrorAt,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(
        and(
          notIntegration,
          sql`${socialMediaChannels.connectionStatus} IN ('expired', 'error', 'revoked')`,
        ),
      )
      .limit(50);

    return {
      byPlatform: channelsByPlatform,
      byStatus: channelsByStatus,
      brokenByPlatform,
      problemChannels,
    };
  }

  /**
   * Every connected account across every customer, one page at a time.
   *
   * `needsAttention` is a filter rather than a stored flag, and it means the
   * same thing here as everywhere else in admin: a connection status of
   * expired, error or revoked. Keeping the definition in one place stops the
   * channels list and the workspace health view from disagreeing about what
   * "broken" is.
   */
  async getAdminChannels(options: {
    page?: number;
    limit?: number;
    search?: string;
    platform?: string;
    status?: string;
    needsAttention?: boolean;
  }) {
    const {
      page = 1,
      limit = 20,
      search,
      platform,
      status,
      needsAttention,
    } = options;
    const offset = (page - 1) * limit;

    // Publishing channels only. Cloud and calendar integrations share this
    // table but are a different thing — they do not publish, do not consume a
    // channel slot (`isBillablePlatform` draws the same line), and belong to an
    // integrations surface rather than here. Excluded by platform, not by the
    // `category` column, which is unreliable until its backfill has run.
    const conditions: any[] = [
      notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
    ];
    if (platform) {
      conditions.push(eq(socialMediaChannels.platform, platform));
    }
    if (status) {
      conditions.push(eq(socialMediaChannels.connectionStatus, status));
    }
    if (needsAttention) {
      conditions.push(
        sql`${socialMediaChannels.connectionStatus} IN ('expired', 'error', 'revoked')`,
      );
    }
    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(
        or(
          ilike(socialMediaChannels.accountName, term),
          ilike(socialMediaChannels.username, term),
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [channelsList, totalCount] = await Promise.all([
      this.db
        .select({
          id: socialMediaChannels.id,
          platform: socialMediaChannels.platform,
          category: socialMediaChannels.category,
          accountType: socialMediaChannels.accountType,
          accountName: socialMediaChannels.accountName,
          username: socialMediaChannels.username,
          profilePictureUrl: socialMediaChannels.profilePictureUrl,
          connectionStatus: socialMediaChannels.connectionStatus,
          lastError: socialMediaChannels.lastError,
          lastErrorAt: socialMediaChannels.lastErrorAt,
          consecutiveErrors: socialMediaChannels.consecutiveErrors,
          tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
          lastSyncedAt: socialMediaChannels.lastSyncedAt,
          isActive: socialMediaChannels.isActive,
          createdAt: socialMediaChannels.createdAt,
          workspaceId: socialMediaChannels.workspaceId,
          // The owning workspace's name, correlated to the channel's row. The
          // identifier is written out qualified on purpose: in this select
          // Drizzle would otherwise emit `workspace_id` bare, and the subquery
          // would read it as its own column and match nothing.
          workspaceName: sql<string>`(
            SELECT ws.name
            FROM ${workspace} AS ws
            WHERE ws.id = ${socialMediaChannels.workspaceId}
          )`,
        })
        .from(socialMediaChannels)
        .where(where)
        .orderBy(desc(socialMediaChannels.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(socialMediaChannels)
        .where(where),
    ]);

    const total = totalCount[0]?.count ?? 0;

    return {
      channels: channelsList,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==========================================================================
  // Billing Management
  // ==========================================================================

  /**
   * Every workspace's subscription, one page at a time — the cross-customer
   * view the revenue screen needs and that no existing method provided
   * (`getRevenueStats` returns aggregate counts, `getWorkspaceBilling` is
   * scoped to one workspace).
   *
   * Each row carries its recurring monthly contribution. That is the sum of the
   * subscription's line items (base plan plus every add-on), which is the real
   * figure a customer is billed. Subscriptions created before any Stripe
   * checkout — a free plan, a hand-seeded row — have no items yet, so the base
   * plan's list price stands in. `COALESCE` picks whichever exists.
   */
  async getAdminSubscriptions(options: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    planCode?: string;
  }) {
    const { page = 1, limit = 20, search, status, planCode } = options;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (status) {
      conditions.push(eq(subscriptions.status, status));
    }
    if (planCode) {
      conditions.push(eq(subscriptions.planCode, planCode));
    }
    if (search?.trim()) {
      conditions.push(ilike(workspace.name, `%${search.trim()}%`));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Recurring monthly revenue for one subscription: the sum of its line
    // items, or the plan's base price when it has none. Written as a scalar
    // subquery so it stays a per-row value the outer query can also order by.
    const mrrCents = sql<number>`COALESCE(
      (
        SELECT SUM(si.quantity * si.unit_price_cents)
        FROM ${subscriptionItems} AS si
        WHERE si.subscription_id = ${subscriptions.id}
      ),
      ${plans.basePriceCents}
    )`;

    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          id: subscriptions.id,
          workspaceId: subscriptions.workspaceId,
          workspaceName: workspace.name,
          planCode: subscriptions.planCode,
          planName: plans.name,
          basePriceCents: plans.basePriceCents,
          status: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEnd: subscriptions.trialEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          canceledAt: subscriptions.canceledAt,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
          createdAt: subscriptions.createdAt,
          mrrCents,
          // How many add-ons ride on top of the base plan. Everything that is
          // not the base plan line is an add-on the customer bought.
          addonCount: sql<number>`(
            SELECT COUNT(*)
            FROM ${subscriptionItems} AS si
            WHERE si.subscription_id = ${subscriptions.id}
              AND si.item_type <> 'BASE_PLAN'
          )`,
        })
        .from(subscriptions)
        .innerJoin(workspace, eq(workspace.id, subscriptions.workspaceId))
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(where)
        .orderBy(desc(subscriptions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(subscriptions)
        .innerJoin(workspace, eq(workspace.id, subscriptions.workspaceId))
        .where(where),
    ]);

    const total = totalCount[0]?.count ?? 0;

    return {
      subscriptions: rows.map((row) => ({
        ...row,
        mrrCents: Number(row.mrrCents) || 0,
        addonCount: Number(row.addonCount) || 0,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Every invoice across every customer, newest first. Invoices carry no
   * workspace_id — they hang off the subscription — so the workspace comes
   * through the same join `getWorkspaceBilling` uses, just without the
   * per-workspace filter.
   */
  async getAdminInvoices(options: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
    const { page = 1, limit = 20, search, status } = options;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (status) {
      conditions.push(eq(invoices.status, status));
    }
    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(
        or(ilike(workspace.name, term), ilike(invoices.stripeInvoiceId, term)),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalCount] = await Promise.all([
      this.db
        .select({
          id: invoices.id,
          stripeInvoiceId: invoices.stripeInvoiceId,
          workspaceId: subscriptions.workspaceId,
          workspaceName: workspace.name,
          planCode: subscriptions.planCode,
          status: invoices.status,
          totalCents: invoices.totalCents,
          amountPaidCents: invoices.amountPaidCents,
          amountDueCents: invoices.amountDueCents,
          currency: invoices.currency,
          periodStart: invoices.periodStart,
          periodEnd: invoices.periodEnd,
          paidAt: invoices.paidAt,
          hostedInvoiceUrl: invoices.hostedInvoiceUrl,
          invoicePdfUrl: invoices.invoicePdfUrl,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .innerJoin(
          subscriptions,
          eq(subscriptions.id, invoices.subscriptionId),
        )
        .innerJoin(workspace, eq(workspace.id, subscriptions.workspaceId))
        .where(where)
        .orderBy(desc(invoices.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(invoices)
        .innerJoin(
          subscriptions,
          eq(subscriptions.id, invoices.subscriptionId),
        )
        .innerJoin(workspace, eq(workspace.id, subscriptions.workspaceId))
        .where(where),
    ]);

    const total = totalCount[0]?.count ?? 0;

    return {
      invoices: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * The add-on catalogue paired with how much of it customers actually buy.
   *
   * The catalogue half is `addon_pricing`: what an add-on costs, per plan. The
   * adoption half comes from the subscription line items customers hold — how
   * many workspaces carry each add-on type, and the recurring revenue it brings
   * in. The two are keyed by add-on type so the UI can show price and uptake on
   * one row.
   */
  async getAdminAddons() {
    const [catalogue, adoption] = await Promise.all([
      this.db
        .select({
          id: addonPricing.id,
          planCode: addonPricing.planCode,
          addonType: addonPricing.addonType,
          pricePerUnitCents: addonPricing.pricePerUnitCents,
          unitsPerQuantity: addonPricing.unitsPerQuantity,
          minQuantity: addonPricing.minQuantity,
          maxQuantity: addonPricing.maxQuantity,
          isActive: addonPricing.isActive,
        })
        .from(addonPricing)
        .orderBy(asc(addonPricing.planCode), asc(addonPricing.addonType)),

      // What is actually purchased, by add-on type. Base-plan lines are not
      // add-ons, so they are excluded; `workspaces` counts distinct
      // subscriptions holding the type, `units` is the total quantity, and
      // `mrrCents` the recurring revenue it accounts for.
      this.db
        .select({
          addonType: subscriptionItems.itemType,
          workspaces: count(),
          units: sum(subscriptionItems.quantity),
          mrrCents: sql<number>`SUM(${subscriptionItems.quantity} * ${subscriptionItems.unitPriceCents})`,
        })
        .from(subscriptionItems)
        .where(sql`${subscriptionItems.itemType} <> 'BASE_PLAN'`)
        .groupBy(subscriptionItems.itemType),
    ]);

    return {
      catalogue,
      adoption: adoption.map((row) => ({
        addonType: row.addonType,
        workspaces: Number(row.workspaces) || 0,
        units: Number(row.units) || 0,
        mrrCents: Number(row.mrrCents) || 0,
      })),
    };
  }

  // ==========================================================================
  // Revenue (Platform)
  // ==========================================================================

  /**
   * The revenue screen's live figures in one call: the MRR broken down by the
   * health of the subscription behind it, the plan distribution, an invoice
   * summary, and the payment-failure picture.
   *
   * Two things this deliberately does NOT return, because the data to do them
   * honestly is not recorded yet — the frontend shows them as gaps rather than
   * inventing numbers:
   *   • a monthly MRR-movement series (new/expansion/contraction/churn). The
   *     subscription-change log records upgrades and add-on edits but never a
   *     create or a cancel, so "new" and "churn" cannot be reconstructed.
   *   • decline reasons grouped by Stripe code. Only the free-text failure
   *     message is stored, not the structured `decline_code`; what is returned
   *     here is that message, grouped, and the UI says as much.
   */
  async getAdminRevenue() {
    // The recurring contribution of one subscription — line items summed, or the
    // plan's base price when it predates any checkout. The same scalar the
    // overview and the subscriptions list use, applied here with different
    // status filters to split MRR by health.
    const mrrOf = (statuses: string[]) =>
      this.db
        .select({
          mrrCents: sql<number>`COALESCE(SUM(
            COALESCE(
              (
                SELECT SUM(si.quantity * si.unit_price_cents)
                FROM ${subscriptionItems} AS si
                WHERE si.subscription_id = ${subscriptions.id}
              ),
              ${plans.basePriceCents}
            )
          ), 0)`,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(
          statuses.length === 1
            ? eq(subscriptions.status, statuses[0])
            : inArray(subscriptions.status, statuses),
        );

    const invoiceJoin = () =>
      this.db
        .select({
          status: invoices.status,
          totalCents: invoices.totalCents,
          amountPaidCents: invoices.amountPaidCents,
          amountDueCents: invoices.amountDueCents,
        })
        .from(invoices)
        .innerJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId));

    const [
      activeMrr,
      atRiskMrr,
      lostMrr,
      addonMrr,
      planRows,
      catalogue,
      payingCount,
      invoiceRows,
      declineRows,
    ] = await Promise.all([
      mrrOf(['active']),
      mrrOf(['past_due']),
      mrrOf(['canceled', 'unpaid']),

      // Add-on portion of MRR: line items that are not the base plan, on active
      // subscriptions only (so a canceled sub's add-ons don't inflate it).
      this.db
        .select({
          mrrCents: sql<number>`COALESCE(SUM(${subscriptionItems.quantity} * ${subscriptionItems.unitPriceCents}), 0)`,
        })
        .from(subscriptionItems)
        .innerJoin(
          subscriptions,
          eq(subscriptions.id, subscriptionItems.subscriptionId),
        )
        .where(
          and(
            sql`${subscriptionItems.itemType} <> 'BASE_PLAN'`,
            eq(subscriptions.status, 'active'),
          ),
        ),

      // Plan mix: active subscriptions per plan and the recurring revenue each
      // plan accounts for.
      this.db
        .select({
          planCode: subscriptions.planCode,
          planName: plans.name,
          basePriceCents: plans.basePriceCents,
          workspaces: count(),
          mrrCents: sql<number>`COALESCE(SUM(
            COALESCE(
              (
                SELECT SUM(si.quantity * si.unit_price_cents)
                FROM ${subscriptionItems} AS si
                WHERE si.subscription_id = ${subscriptions.id}
              ),
              ${plans.basePriceCents}
            )
          ), 0)`,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(eq(subscriptions.status, 'active'))
        .groupBy(subscriptions.planCode, plans.name, plans.basePriceCents),

      // The plan catalogue with its limits, for the "what each tier allows" table.
      this.db
        .select({
          code: plans.code,
          name: plans.name,
          basePriceCents: plans.basePriceCents,
          channelsPerWorkspace: plans.channelsPerWorkspace,
          membersPerWorkspace: plans.membersPerWorkspace,
          maxWorkspaces: plans.maxWorkspaces,
          aiTokensPerMonth: plans.aiTokensPerMonth,
          isActive: plans.isActive,
        })
        .from(plans)
        .orderBy(asc(plans.basePriceCents)),

      // Paying accounts: active subscriptions on a plan that costs something.
      this.db
        .select({ count: count() })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(and(eq(subscriptions.status, 'active'), gt(plans.basePriceCents, 0))),

      // Every invoice's status + amounts, for the collected/outstanding/written
      // -off split. Invoices carry no workspace_id, so the join to subscriptions
      // is what gives each one a plan and an owner elsewhere; here it just keeps
      // the row set identical to the invoices list.
      invoiceJoin(),

      // Failure reasons, grouped by the stored message. This is free text, not
      // a Stripe decline code — the frontend surfaces that caveat.
      this.db
        .select({
          reason: failedPayments.failureReason,
          count: count(),
        })
        .from(failedPayments)
        .groupBy(failedPayments.failureReason)
        .orderBy(desc(count())),
    ]);

    // Invoice summary, computed in one pass over the status buckets.
    let collectedCents = 0;
    let outstandingCents = 0;
    let writtenOffCents = 0;
    let paidCount = 0;
    let attemptedCount = 0;
    for (const row of invoiceRows) {
      // Drafts are not a billing attempt; everything else is an issued invoice.
      if (row.status !== 'draft') attemptedCount += 1;
      if (row.status === 'paid') {
        collectedCents += row.amountPaidCents;
        paidCount += 1;
      } else if (row.status === 'open') {
        outstandingCents += row.amountDueCents;
      } else if (row.status === 'uncollectible' || row.status === 'void') {
        writtenOffCents += row.amountDueCents;
      }
    }

    const activeCents = Number(activeMrr[0]?.mrrCents) || 0;
    const planMix = planRows
      .map((row) => ({
        planCode: row.planCode,
        planName: row.planName,
        basePriceCents: row.basePriceCents,
        workspaces: Number(row.workspaces) || 0,
        mrrCents: Number(row.mrrCents) || 0,
      }))
      .sort((a, b) => b.mrrCents - a.mrrCents);

    return {
      mrr: {
        activeCents,
        atRiskCents: Number(atRiskMrr[0]?.mrrCents) || 0,
        lostCents: Number(lostMrr[0]?.mrrCents) || 0,
        fromAddonsCents: Number(addonMrr[0]?.mrrCents) || 0,
        payingAccounts: payingCount[0]?.count || 0,
      },
      planMix,
      catalogue: catalogue.map((row) => ({
        ...row,
        // count() is a number already; the limits are plain integers.
      })),
      invoices: {
        collectedCents,
        outstandingCents,
        writtenOffCents,
        paidCount,
        attemptedCount,
      },
      declineReasons: declineRows.map((row) => ({
        reason: row.reason,
        count: Number(row.count) || 0,
      })),
    };
  }

  // ==========================================================================
  // Dashboard Overview (landing page)
  // ==========================================================================

  /**
   * Everything the admin landing page shows, in one call. `getDashboardOverview`
   * gives headline counts and `getRevenueStats` gives paid-invoice revenue, but
   * neither carries recurring MRR, a per-plan revenue split, or a day-by-day
   * growth series — and the overview wants all three plus period-over-period
   * deltas. Assembling it here keeps the page to a single request.
   *
   * `period` (7/30/90 days) sizes only the time series and the deltas; the
   * headline totals are always the live platform-wide figures.
   */
  async getAdminOverview(period: '7d' | '30d' | '90d' = '30d') {
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    // Window boundaries for the delta: the current period, and the one of equal
    // length immediately before it. "New this period vs the period before" is
    // the honest comparison a dashboard delta implies.
    const periodStart = new Date(now.getTime() - days * dayMs);
    const prevPeriodStart = new Date(now.getTime() - 2 * days * dayMs);

    // Publishing channels only, matching the channels module. The older
    // getDashboardOverview counts integrations here too, which is a discrepancy
    // we deliberately do not carry forward.
    const notIntegration = notInArray(
      socialMediaChannels.platform,
      INTEGRATION_PLATFORMS,
    );

    const [
      totalUsers,
      activeUsers,
      newUsersThisPeriod,
      newUsersPrevPeriod,
      totalWorkspaces,
      activeWorkspaces,
      newWorkspacesThisPeriod,
      newWorkspacesPrevPeriod,
      totalChannels,
      connectedChannels,
      brokenChannels,
      postsAgg,
      failedPostsThisPeriod,
      mrrRow,
      planMixRows,
      userGrowthRows,
      workspaceGrowthRows,
      postSeriesRows,
      aiByWorkspaceRaw,
      recentUsers,
      recentWorkspaces,
    ] = await Promise.all([
      this.db.select({ count: count() }).from(users),
      this.db
        .select({ count: count() })
        .from(users)
        .where(eq(users.isActive, true)),
      this.db
        .select({ count: count() })
        .from(users)
        .where(gte(users.createdAt, periodStart)),
      this.db
        .select({ count: count() })
        .from(users)
        .where(
          and(
            gte(users.createdAt, prevPeriodStart),
            lte(users.createdAt, periodStart),
          ),
        ),

      this.db.select({ count: count() }).from(workspace),
      this.db
        .select({ count: count() })
        .from(workspace)
        .where(eq(workspace.isActive, true)),
      this.db
        .select({ count: count() })
        .from(workspace)
        .where(gte(workspace.createdAt, periodStart)),
      this.db
        .select({ count: count() })
        .from(workspace)
        .where(
          and(
            gte(workspace.createdAt, prevPeriodStart),
            lte(workspace.createdAt, periodStart),
          ),
        ),

      this.db.select({ count: count() }).from(socialMediaChannels).where(notIntegration),
      this.db
        .select({ count: count() })
        .from(socialMediaChannels)
        .where(and(notIntegration, eq(socialMediaChannels.connectionStatus, 'connected'))),
      this.db
        .select({ count: count() })
        .from(socialMediaChannels)
        .where(
          and(
            notIntegration,
            sql`${socialMediaChannels.connectionStatus} IN ('expired', 'error', 'revoked')`,
          ),
        ),

      // Posts by status, as one grouped query rather than four counts.
      this.db
        .select({ status: posts.status, count: count() })
        .from(posts)
        .groupBy(posts.status),
      this.db
        .select({ count: count() })
        .from(posts)
        .where(and(eq(posts.status, 'failed'), gte(posts.createdAt, periodStart))),

      // Platform MRR: every active subscription's recurring contribution summed.
      // The inner scalar mirrors getAdminSubscriptions — line items summed, or
      // the plan's base price when a subscription predates any Stripe checkout.
      this.db
        .select({
          mrrCents: sql<number>`COALESCE(SUM(
            COALESCE(
              (
                SELECT SUM(si.quantity * si.unit_price_cents)
                FROM ${subscriptionItems} AS si
                WHERE si.subscription_id = ${subscriptions.id}
              ),
              ${plans.basePriceCents}
            )
          ), 0)`,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(eq(subscriptions.status, 'active')),

      // Per-plan: how many active subscriptions and how much recurring revenue.
      this.db
        .select({
          planCode: subscriptions.planCode,
          planName: plans.name,
          basePriceCents: plans.basePriceCents,
          count: count(),
          mrrCents: sql<number>`COALESCE(SUM(
            COALESCE(
              (
                SELECT SUM(si.quantity * si.unit_price_cents)
                FROM ${subscriptionItems} AS si
                WHERE si.subscription_id = ${subscriptions.id}
              ),
              ${plans.basePriceCents}
            )
          ), 0)`,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.code, subscriptions.planCode))
        .where(eq(subscriptions.status, 'active'))
        .groupBy(subscriptions.planCode, plans.name, plans.basePriceCents),

      // Daily growth series over the window — one row per day that had signups.
      this.db
        .select({
          date: sql<string>`DATE(${users.createdAt})`,
          count: count(),
        })
        .from(users)
        .where(gte(users.createdAt, periodStart))
        .groupBy(sql`DATE(${users.createdAt})`)
        .orderBy(sql`DATE(${users.createdAt})`),
      this.db
        .select({
          date: sql<string>`DATE(${workspace.createdAt})`,
          count: count(),
        })
        .from(workspace)
        .where(gte(workspace.createdAt, periodStart))
        .groupBy(sql`DATE(${workspace.createdAt})`)
        .orderBy(sql`DATE(${workspace.createdAt})`),

      // Publishing series: posts per day split by status, for the stacked chart.
      this.db
        .select({
          date: sql<string>`DATE(${posts.createdAt})`,
          status: posts.status,
          count: count(),
        })
        .from(posts)
        .where(gte(posts.createdAt, periodStart))
        .groupBy(sql`DATE(${posts.createdAt})`, posts.status)
        .orderBy(sql`DATE(${posts.createdAt})`),

      // Top AI spenders by tokens (there is no per-workspace dollar cost stored,
      // so the overview shows tokens, not a fabricated dollar figure).
      this.db
        .select({
          workspaceId: aiUsageLog.workspaceId,
          workspaceName: workspace.name,
          totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
          operations: count(),
        })
        .from(aiUsageLog)
        .innerJoin(workspace, eq(workspace.id, aiUsageLog.workspaceId))
        .where(gte(aiUsageLog.createdAt, periodStart))
        .groupBy(aiUsageLog.workspaceId, workspace.name)
        .orderBy(sql`SUM(${aiUsageLog.tokensUsed}) DESC`)
        .limit(5),

      this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(6),
      this.db
        .select({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          createdAt: workspace.createdAt,
        })
        .from(workspace)
        .orderBy(desc(workspace.createdAt))
        .limit(6),
    ]);

    const postsByStatus = new Map(
      postsAgg.map((row) => [row.status, row.count]),
    );
    const postsTotal = postsAgg.reduce((sum, row) => sum + row.count, 0);

    // Percentage change, guarding the divide-by-zero: from nothing to something
    // is "new", not an infinite percentage.
    const delta = (current: number, previous: number): number | null => {
      if (previous === 0) return current > 0 ? null : 0;
      return Math.round(((current - previous) / previous) * 1000) / 10;
    };

    const usersThisPeriod = newUsersThisPeriod[0]?.count || 0;
    const usersPrevPeriod = newUsersPrevPeriod[0]?.count || 0;
    const wsThisPeriod = newWorkspacesThisPeriod[0]?.count || 0;
    const wsPrevPeriod = newWorkspacesPrevPeriod[0]?.count || 0;

    return {
      period,
      users: {
        total: totalUsers[0]?.count || 0,
        active: activeUsers[0]?.count || 0,
        suspended: (totalUsers[0]?.count || 0) - (activeUsers[0]?.count || 0),
        newThisPeriod: usersThisPeriod,
        delta: delta(usersThisPeriod, usersPrevPeriod),
      },
      workspaces: {
        total: totalWorkspaces[0]?.count || 0,
        active: activeWorkspaces[0]?.count || 0,
        suspended:
          (totalWorkspaces[0]?.count || 0) - (activeWorkspaces[0]?.count || 0),
        newThisPeriod: wsThisPeriod,
        delta: delta(wsThisPeriod, wsPrevPeriod),
      },
      channels: {
        total: totalChannels[0]?.count || 0,
        connected: connectedChannels[0]?.count || 0,
        broken: brokenChannels[0]?.count || 0,
      },
      posts: {
        total: postsTotal,
        published: postsByStatus.get('published') || 0,
        scheduled: postsByStatus.get('scheduled') || 0,
        failed: postsByStatus.get('failed') || 0,
        failedThisPeriod: failedPostsThisPeriod[0]?.count || 0,
      },
      revenue: {
        mrrCents: Number(mrrRow[0]?.mrrCents) || 0,
        byPlan: planMixRows
          .map((row) => ({
            planCode: row.planCode,
            planName: row.planName,
            count: Number(row.count) || 0,
            mrrCents: Number(row.mrrCents) || 0,
          }))
          .sort((a, b) => b.mrrCents - a.mrrCents),
      },
      growth: {
        users: userGrowthRows.map((r) => ({
          date: r.date,
          count: Number(r.count) || 0,
        })),
        workspaces: workspaceGrowthRows.map((r) => ({
          date: r.date,
          count: Number(r.count) || 0,
        })),
      },
      publishing: postSeriesRows.map((r) => ({
        date: r.date,
        status: r.status,
        count: Number(r.count) || 0,
      })),
      topSpenders: aiByWorkspaceRaw.map((r) => ({
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        tokens: Number(r.totalTokens) || 0,
        operations: Number(r.operations) || 0,
      })),
      recentActivity: {
        users: recentUsers,
        workspaces: recentWorkspaces,
      },
    };
  }

  // ==========================================================================
  // Posts Analytics
  // ==========================================================================

  async getPostStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Posts by status
    const postsByStatus = await this.db
      .select({
        status: posts.status,
        count: count(),
      })
      .from(posts)
      .groupBy(posts.status);

    // Recent failed posts
    const recentFailedPosts = await this.db
      .select({
        id: posts.id,
        workspaceId: posts.workspaceId,
        status: posts.status,
        lastError: posts.lastError,
        scheduledAt: posts.scheduledAt,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(eq(posts.status, 'failed'))
      .orderBy(desc(posts.createdAt))
      .limit(20);

    // Posts in last 30 days by day
    const postsLast30Days = await this.db
      .select({
        date: sql<string>`DATE(${posts.createdAt})`,
        count: count(),
      })
      .from(posts)
      .where(gte(posts.createdAt, thirtyDaysAgo))
      .groupBy(sql`DATE(${posts.createdAt})`)
      .orderBy(sql`DATE(${posts.createdAt})`);

    return {
      byStatus: postsByStatus,
      recentFailed: recentFailedPosts,
      last30Days: postsLast30Days,
    };
  }

  // ==========================================================================
  // Revenue & Billing Analytics
  // ==========================================================================

  async getRevenueStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Subscriptions by status
    const subscriptionsByStatus = await this.db
      .select({
        status: subscriptions.status,
        count: count(),
      })
      .from(subscriptions)
      .groupBy(subscriptions.status);

    // Subscriptions by plan
    const subscriptionsByPlan = await this.db
      .select({
        planCode: subscriptions.planCode,
        count: count(),
      })
      .from(subscriptions)
      .groupBy(subscriptions.planCode);

    // Total revenue (sum of paid invoices)
    const [totalRevenue] = await this.db
      .select({
        total: sum(invoices.amountPaidCents),
      })
      .from(invoices)
      .where(eq(invoices.status, 'paid'));

    // Revenue last 30 days
    const [revenueLast30Days] = await this.db
      .select({
        total: sum(invoices.amountPaidCents),
      })
      .from(invoices)
      .where(
        and(eq(invoices.status, 'paid'), gte(invoices.paidAt, thirtyDaysAgo)),
      );

    // Recent failed payments
    const recentFailedPayments = await this.db
      .select({
        id: failedPayments.id,
        subscriptionId: failedPayments.subscriptionId,
        failureReason: failedPayments.failureReason,
        attemptCount: failedPayments.attemptCount,
        resolved: failedPayments.resolved,
        createdAt: failedPayments.createdAt,
      })
      .from(failedPayments)
      .where(eq(failedPayments.resolved, false))
      .orderBy(desc(failedPayments.createdAt))
      .limit(20);

    return {
      subscriptions: {
        byStatus: subscriptionsByStatus,
        byPlan: subscriptionsByPlan,
      },
      revenue: {
        totalCents: Number(totalRevenue?.total) || 0,
        totalFormatted: `$${((Number(totalRevenue?.total) || 0) / 100).toFixed(2)}`,
        last30DaysCents: Number(revenueLast30Days?.total) || 0,
        last30DaysFormatted: `$${((Number(revenueLast30Days?.total) || 0) / 100).toFixed(2)}`,
      },
      recentFailedPayments,
    };
  }

  // ==========================================================================
  // System Health
  // ==========================================================================

  async getSystemHealth() {
    // Get counts of various issues
    const [expiredChannels, failedPostsCount, unresolvedPayments] =
      await Promise.all([
        this.db
          .select({ count: count() })
          .from(socialMediaChannels)
          .where(eq(socialMediaChannels.connectionStatus, 'expired')),
        this.db
          .select({ count: count() })
          .from(posts)
          .where(eq(posts.status, 'failed')),
        this.db
          .select({ count: count() })
          .from(failedPayments)
          .where(eq(failedPayments.resolved, false)),
      ]);

    return {
      status: 'healthy', // Can be enhanced with actual health checks
      issues: {
        expiredChannels: expiredChannels[0]?.count || 0,
        failedPosts: failedPostsCount[0]?.count || 0,
        unresolvedPayments: unresolvedPayments[0]?.count || 0,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // Recent Activity
  // ==========================================================================

  async getRecentActivity(limit = 20) {
    // Recent users
    const recentUsers = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit);

    // Recent workspaces
    const recentWorkspaces = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
      })
      .from(workspace)
      .orderBy(desc(workspace.createdAt))
      .limit(limit);

    return {
      recentUsers,
      recentWorkspaces,
    };
  }

  // ==========================================================================
  // AI Usage Statistics
  // ==========================================================================

  async getAiUsageStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Total stats
    const [totalStats] = await this.db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
        totalOperations: count(),
        successfulOperations: sql<number>`COUNT(*) FILTER (WHERE ${aiUsageLog.success} = true)`,
        failedOperations: sql<number>`COUNT(*) FILTER (WHERE ${aiUsageLog.success} = false)`,
      })
      .from(aiUsageLog);

    // Last 30 days stats
    const [last30DaysStats] = await this.db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
        totalOperations: count(),
      })
      .from(aiUsageLog)
      .where(gte(aiUsageLog.createdAt, thirtyDaysAgo));

    // Last 7 days stats
    const [last7DaysStats] = await this.db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
        totalOperations: count(),
      })
      .from(aiUsageLog)
      .where(gte(aiUsageLog.createdAt, sevenDaysAgo));

    // Unique users who used AI
    const [uniqueUsers] = await this.db
      .select({
        total: sql<number>`COUNT(DISTINCT ${aiUsageLog.userId})`,
        last30Days: sql<number>`COUNT(DISTINCT ${aiUsageLog.userId}) FILTER (WHERE ${aiUsageLog.createdAt} >= ${thirtyDaysAgo})`,
      })
      .from(aiUsageLog);

    // Stats by operation
    const operationStats = await this.db
      .select({
        operation: aiUsageLog.operation,
        count: count(),
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
      })
      .from(aiUsageLog)
      .groupBy(aiUsageLog.operation)
      .orderBy(sql`COUNT(*) DESC`);

    // Stats by workspace (top 10)
    const workspaceStatsRaw = await this.db
      .select({
        workspaceId: aiUsageLog.workspaceId,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLog.tokensUsed}), 0)`,
        operationCount: count(),
      })
      .from(aiUsageLog)
      .groupBy(aiUsageLog.workspaceId)
      .orderBy(sql`SUM(${aiUsageLog.tokensUsed}) DESC`)
      .limit(10);

    // Get workspace names
    const workspaceStats = await Promise.all(
      workspaceStatsRaw.map(async (ws) => {
        const wsData = await this.db.query.workspace.findFirst({
          where: eq(workspace.id, ws.workspaceId),
          columns: { name: true, slug: true },
        });
        return {
          workspaceId: ws.workspaceId,
          workspaceName: wsData?.name || 'Unknown',
          workspaceSlug: wsData?.slug || 'unknown',
          totalTokens: Number(ws.totalTokens),
          operationCount: Number(ws.operationCount),
        };
      }),
    );

    return {
      totals: {
        totalTokensConsumed: Number(totalStats?.totalTokens) || 0,
        totalOperations: Number(totalStats?.totalOperations) || 0,
        successfulOperations: Number(totalStats?.successfulOperations) || 0,
        failedOperations: Number(totalStats?.failedOperations) || 0,
        uniqueUsers: Number(uniqueUsers?.total) || 0,
      },
      last30Days: {
        tokensConsumed: Number(last30DaysStats?.totalTokens) || 0,
        operations: Number(last30DaysStats?.totalOperations) || 0,
        uniqueUsers: Number(uniqueUsers?.last30Days) || 0,
      },
      last7Days: {
        tokensConsumed: Number(last7DaysStats?.totalTokens) || 0,
        operations: Number(last7DaysStats?.totalOperations) || 0,
      },
      byOperation: operationStats.map((op) => ({
        operation: op.operation,
        count: Number(op.count),
        totalTokens: Number(op.totalTokens),
      })),
      byWorkspace: workspaceStats,
    };
  }

  async getAiUsageActivity(limit = 50) {
    const logs = await this.db
      .select({
        id: aiUsageLog.id,
        workspaceId: aiUsageLog.workspaceId,
        userId: aiUsageLog.userId,
        operation: aiUsageLog.operation,
        tokensUsed: aiUsageLog.tokensUsed,
        platform: aiUsageLog.platform,
        inputSummary: aiUsageLog.inputSummary,
        success: aiUsageLog.success,
        errorMessage: aiUsageLog.errorMessage,
        createdAt: aiUsageLog.createdAt,
      })
      .from(aiUsageLog)
      .orderBy(desc(aiUsageLog.createdAt))
      .limit(limit);

    // Enrich with user and workspace info
    const enrichedLogs = await Promise.all(
      logs.map(async (log) => {
        const [user, ws] = await Promise.all([
          this.db.query.users.findFirst({
            where: eq(users.id, log.userId),
            columns: { email: true, name: true },
          }),
          this.db.query.workspace.findFirst({
            where: eq(workspace.id, log.workspaceId),
            columns: { name: true, slug: true },
          }),
        ]);

        return {
          ...log,
          user: user ? { email: user.email, name: user.name } : null,
          workspace: ws ? { name: ws.name, slug: ws.slug } : null,
        };
      }),
    );

    return enrichedLogs;
  }

  // ==========================================================================
  // Storage Usage (Costs → Storage tab)
  // ==========================================================================

  /**
   * What every workspace is storing, straight from our own counters.
   *
   * This is the one storage figure only we can produce: R2 and Cloudinary see
   * buckets, not customers. The bytes come from `media_items.file_size`, summed
   * per workspace, with soft-deleted rows excluded so the number matches what a
   * customer would actually see in their library. `cloudinaryPublicId` splits
   * the total by provider — a rough proxy, since it marks where a file lives,
   * not what it costs.
   *
   * The external provider bills (R2 metrics, Cloudinary quota) are deliberately
   * absent: they need each vendor's usage API wired up, which the Storage tab
   * flags as not-yet-connected rather than inventing a number for.
   */
  async getStorageUsage() {
    const BYTES_PER_GB = 1024 * 1024 * 1024;

    // Per-workspace totals — only files that still exist, so the figure lines
    // up with the customer's own library rather than the raw bucket.
    const perWorkspaceRaw = await this.db
      .select({
        workspaceId: mediaItems.workspaceId,
        bytes: sql<number>`COALESCE(SUM(${mediaItems.fileSize}), 0)`,
        objects: count(),
        cloudinaryBytes: sql<number>`COALESCE(SUM(${mediaItems.fileSize}) FILTER (WHERE ${mediaItems.cloudinaryPublicId} IS NOT NULL), 0)`,
      })
      .from(mediaItems)
      .where(eq(mediaItems.isDeleted, false))
      .groupBy(mediaItems.workspaceId)
      .orderBy(sql`SUM(${mediaItems.fileSize}) DESC NULLS LAST`);

    // Attach names in one pass so the table can label rows without the caller
    // resolving ids itself.
    const perWorkspace = await Promise.all(
      perWorkspaceRaw.map(async (row) => {
        const ws = await this.db.query.workspace.findFirst({
          where: eq(workspace.id, row.workspaceId),
          columns: { name: true, slug: true },
        });
        const bytes = Number(row.bytes) || 0;
        return {
          workspaceId: row.workspaceId,
          workspaceName: ws?.name ?? 'Unknown',
          workspaceSlug: ws?.slug ?? 'unknown',
          bytes,
          gb: bytes / BYTES_PER_GB,
          objects: Number(row.objects) || 0,
          cloudinaryBytes: Number(row.cloudinaryBytes) || 0,
        };
      }),
    );

    const totalBytes = perWorkspace.reduce((sum, r) => sum + r.bytes, 0);
    const cloudinaryBytes = perWorkspace.reduce(
      (sum, r) => sum + r.cloudinaryBytes,
      0,
    );
    const totalObjects = perWorkspace.reduce((sum, r) => sum + r.objects, 0);

    return {
      totals: {
        totalBytes,
        totalGb: totalBytes / BYTES_PER_GB,
        totalObjects,
        workspaceCount: perWorkspace.length,
        // Provider split is a proxy: a file carrying a Cloudinary public id
        // lives on Cloudinary, everything else on R2. It maps location, not
        // cost — the actual bills come from each vendor's own usage API.
        cloudinaryBytes,
        r2Bytes: totalBytes - cloudinaryBytes,
      },
      byWorkspace: perWorkspace,
    };
  }
}
