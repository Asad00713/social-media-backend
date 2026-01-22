import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { eq, sql, count, sum, and, gte, lte, desc, isNull, isNotNull } from 'drizzle-orm';
import {
  users,
  workspace,
  socialMediaChannels,
  posts,
  subscriptions,
  invoices,
  failedPayments,
  stripeCustomers,
  plans,
  aiUsageLog,
  workspaceUsage,
} from '../drizzle/schema';

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
      this.db.select({ count: count() }).from(users).where(eq(users.isActive, true)),
      // New users in last 30 days
      this.db.select({ count: count() }).from(users).where(gte(users.createdAt, thirtyDaysAgo)),
      // Total workspaces
      this.db.select({ count: count() }).from(workspace),
      // Active workspaces (not suspended)
      this.db.select({ count: count() }).from(workspace).where(eq(workspace.isActive, true)),
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
      this.db.select({ count: count() }).from(posts).where(eq(posts.status, 'published')),
      // Scheduled posts
      this.db.select({ count: count() }).from(posts).where(eq(posts.status, 'scheduled')),
      // Failed posts
      this.db.select({ count: count() }).from(posts).where(eq(posts.status, 'failed')),
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
        suspended: (totalWorkspaces[0]?.count || 0) - (activeWorkspaces[0]?.count || 0),
      },
      channels: {
        total: totalChannels[0]?.count || 0,
        connected: connectedChannels[0]?.count || 0,
        disconnected: (totalChannels[0]?.count || 0) - (connectedChannels[0]?.count || 0),
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
    role?: string;
  }) {
    const { page = 1, limit = 20, search, isActive, role } = options;
    const offset = (page - 1) * limit;

    // Build conditions
    const conditions: any[] = [];
    if (isActive !== undefined) {
      conditions.push(eq(users.isActive, isActive));
    }
    if (role) {
      conditions.push(eq(users.role, role as any));
    }

    // Get users with pagination
    const usersQuery = this.db
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
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      usersQuery.where(and(...conditions));
    }

    const [usersList, totalCount] = await Promise.all([
      usersQuery,
      this.db.select({ count: count() }).from(users),
    ]);

    // Filter by search if provided (in JS since drizzle doesn't support ILIKE easily)
    let filteredUsers = usersList;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredUsers = usersList.filter(
        (u) =>
          u.email.toLowerCase().includes(searchLower) ||
          u.name?.toLowerCase().includes(searchLower),
      );
    }

    return {
      users: filteredUsers,
      pagination: {
        page,
        limit,
        total: totalCount[0]?.count || 0,
        totalPages: Math.ceil((totalCount[0]?.count || 0) / limit),
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
  }) {
    const { page = 1, limit = 20, search, isActive } = options;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (isActive !== undefined) {
      conditions.push(eq(workspace.isActive, isActive));
    }

    const workspacesQuery = this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        isActive: workspace.isActive,
        suspendedAt: workspace.suspendedAt,
        suspendedReason: workspace.suspendedReason,
        ownerId: workspace.ownerId,
        createdAt: workspace.createdAt,
      })
      .from(workspace)
      .orderBy(desc(workspace.createdAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      workspacesQuery.where(and(...conditions));
    }

    const [workspacesList, totalCount] = await Promise.all([
      workspacesQuery,
      this.db.select({ count: count() }).from(workspace),
    ]);

    // Get owner details for each workspace
    const workspacesWithOwners = await Promise.all(
      workspacesList.map(async (ws) => {
        const owner = await this.db.query.users.findFirst({
          where: eq(users.id, ws.ownerId),
          columns: { id: true, email: true, name: true },
        });
        return { ...ws, owner };
      }),
    );

    // Filter by search
    let filteredWorkspaces = workspacesWithOwners;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredWorkspaces = workspacesWithOwners.filter(
        (w) =>
          w.name.toLowerCase().includes(searchLower) ||
          w.slug.toLowerCase().includes(searchLower) ||
          w.owner?.email?.toLowerCase().includes(searchLower),
      );
    }

    return {
      workspaces: filteredWorkspaces,
      pagination: {
        page,
        limit,
        total: totalCount[0]?.count || 0,
        totalPages: Math.ceil((totalCount[0]?.count || 0) / limit),
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

    // Get owner
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, ws.ownerId),
      columns: { id: true, email: true, name: true },
    });

    // Get channels count
    const [channelsCount] = await this.db
      .select({ count: count() })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId));

    // Get posts count
    const [postsCount] = await this.db
      .select({ count: count() })
      .from(posts)
      .where(eq(posts.workspaceId, workspaceId));

    // Get subscription
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.workspaceId, workspaceId),
    });

    return {
      ...ws,
      owner,
      stats: {
        channelsCount: channelsCount?.count || 0,
        postsCount: postsCount?.count || 0,
      },
      subscription: subscription
        ? {
            planCode: subscription.planCode,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
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
    // Channels by platform
    const channelsByPlatform = await this.db
      .select({
        platform: socialMediaChannels.platform,
        count: count(),
      })
      .from(socialMediaChannels)
      .groupBy(socialMediaChannels.platform)
      .orderBy(desc(count()));

    // Channels by status
    const channelsByStatus = await this.db
      .select({
        status: socialMediaChannels.connectionStatus,
        count: count(),
      })
      .from(socialMediaChannels)
      .groupBy(socialMediaChannels.connectionStatus);

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
        sql`${socialMediaChannels.connectionStatus} IN ('expired', 'error', 'revoked')`,
      )
      .limit(50);

    return {
      byPlatform: channelsByPlatform,
      byStatus: channelsByStatus,
      problemChannels,
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
        and(
          eq(invoices.status, 'paid'),
          gte(invoices.paidAt, thirtyDaysAgo),
        ),
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
    const [
      expiredChannels,
      failedPostsCount,
      unresolvedPayments,
    ] = await Promise.all([
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
}
