import {
  Injectable,
  Logger,
  Inject,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  workspaceUsage,
  subscriptions,
  plans,
  aiUsageLog,
  usageEvents,
} from '../../drizzle/schema';
import { eq, sql } from 'drizzle-orm';

// Token costs per operation
export const AI_OPERATION_COSTS: Record<string, number> = {
  // Tier 1 - Basic (2 tokens)
  generate_hashtags: 2,
  generate_bio: 2,
  // Tier 2 - Standard (5 tokens)
  generate_post: 5,
  generate_caption: 5,
  improve_post: 5,
  repurpose_content: 5,
  translate_content: 5,
  speech_to_text: 5, // Voice input transcription
  // Tier 3 - Advanced (8 tokens)
  generate_ideas: 8,
  generate_youtube_metadata: 8,
  generate_variations: 8,
  analyze_post: 8,
  // Tier 4 - Complex (10 tokens)
  generate_thread: 10,
  // Tier 5 - Premium (15 tokens per platform)
  generate_drip_content: 15,
};

export interface TokenCheckResult {
  hasAccess: boolean;
  tokensAvailable: number;
  tokensRequired: number;
  monthlyLimit: number;
  usedThisMonth: number;
  extraPurchased: number;
  resetsAt: Date | null;
  message?: string;
}

export interface TokenDeductResult {
  success: boolean;
  tokensDeducted: number;
  tokensRemaining: number;
  monthlyLimit: number;
  resetsAt: Date | null;
}

export interface LogUsageParams {
  workspaceId: string;
  userId: string;
  operation: string;
  tokensUsed: number;
  platform?: string;
  inputSummary?: string;
  outputLength?: number;
  success: boolean;
  errorMessage?: string;
  apiInputTokens?: number;
  apiOutputTokens?: number;
}

@Injectable()
export class AiTokenService {
  private readonly logger = new Logger(AiTokenService.name);

  constructor(@Inject(DRIZZLE) private db: DbType) {}

  /**
   * Get the token cost for an operation
   */
  getOperationCost(operation: string): number {
    return AI_OPERATION_COSTS[operation] || 5; // Default to 5 if unknown
  }

  /**
   * Check if workspace has AI access and sufficient tokens
   */
  async checkTokens(
    workspaceId: string,
    operation: string,
  ): Promise<TokenCheckResult> {
    const tokensRequired = this.getOperationCost(operation);

    // Get workspace subscription to check plan
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.workspaceId, workspaceId),
      with: {
        plan: true,
      },
    });

    if (!subscription || subscription.status !== 'active') {
      return {
        hasAccess: false,
        tokensAvailable: 0,
        tokensRequired,
        monthlyLimit: 0,
        usedThisMonth: 0,
        extraPurchased: 0,
        resetsAt: null,
        message: 'No active subscription found',
      };
    }

    const plan = subscription.plan;
    if (!plan || plan.aiTokensPerMonth === 0) {
      return {
        hasAccess: false,
        tokensAvailable: 0,
        tokensRequired,
        monthlyLimit: 0,
        usedThisMonth: 0,
        extraPurchased: 0,
        resetsAt: null,
        message: 'Your plan does not include AI features. Please upgrade to Pro or Max.',
      };
    }

    // Get workspace usage
    let usage = await this.db.query.workspaceUsage.findFirst({
      where: eq(workspaceUsage.workspaceId, workspaceId),
    });

    // Initialize usage if not exists
    if (!usage) {
      const resetDate = this.getNextResetDate();
      const [newUsage] = await this.db
        .insert(workspaceUsage)
        .values({
          workspaceId,
          channelsCount: 0,
          channelsLimit: plan.channelsPerWorkspace,
          membersCount: 1,
          membersLimit: plan.membersPerWorkspace,
          aiTokensUsedThisMonth: 0,
          aiTokensLimit: plan.aiTokensPerMonth,
          extraAiTokensPurchased: 0,
          aiTokensResetDate: resetDate,
        })
        .returning();
      usage = newUsage;
    }

    // Check if we need to reset tokens (new month)
    if (usage.aiTokensResetDate && new Date() >= usage.aiTokensResetDate) {
      await this.resetMonthlyTokens(workspaceId, plan.aiTokensPerMonth);
      usage = await this.db.query.workspaceUsage.findFirst({
        where: eq(workspaceUsage.workspaceId, workspaceId),
      });
    }

    const totalAvailable =
      (usage?.aiTokensLimit || 0) +
      (usage?.extraAiTokensPurchased || 0) -
      (usage?.aiTokensUsedThisMonth || 0);

    return {
      hasAccess: totalAvailable >= tokensRequired,
      tokensAvailable: Math.max(0, totalAvailable),
      tokensRequired,
      monthlyLimit: usage?.aiTokensLimit || 0,
      usedThisMonth: usage?.aiTokensUsedThisMonth || 0,
      extraPurchased: usage?.extraAiTokensPurchased || 0,
      resetsAt: usage?.aiTokensResetDate || null,
      message:
        totalAvailable < tokensRequired
          ? `Insufficient tokens. You need ${tokensRequired} tokens but only have ${totalAvailable} available.`
          : undefined,
    };
  }

  /**
   * Deduct tokens after successful AI operation
   */
  async deductTokens(
    workspaceId: string,
    userId: string,
    operation: string,
    tokensUsed?: number,
  ): Promise<TokenDeductResult> {
    const tokens = tokensUsed || this.getOperationCost(operation);

    // Update workspace usage
    const [updated] = await this.db
      .update(workspaceUsage)
      .set({
        aiTokensUsedThisMonth: sql`${workspaceUsage.aiTokensUsedThisMonth} + ${tokens}`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .returning();

    // Log usage event for audit trail
    await this.db.insert(usageEvents).values({
      workspaceId,
      eventType: 'AI_TOKENS_USED',
      resourceType: 'AI_TOKENS',
      quantityBefore: updated.aiTokensUsedThisMonth - tokens,
      quantityAfter: updated.aiTokensUsedThisMonth,
      quantityDelta: tokens,
      triggeredByUserId: userId,
      metadata: { operation },
    });

    const tokensRemaining =
      updated.aiTokensLimit +
      updated.extraAiTokensPurchased -
      updated.aiTokensUsedThisMonth;

    return {
      success: true,
      tokensDeducted: tokens,
      tokensRemaining: Math.max(0, tokensRemaining),
      monthlyLimit: updated.aiTokensLimit,
      resetsAt: updated.aiTokensResetDate,
    };
  }

  /**
   * Log AI usage for detailed tracking
   */
  async logUsage(params: LogUsageParams): Promise<void> {
    await this.db.insert(aiUsageLog).values({
      workspaceId: params.workspaceId,
      userId: params.userId,
      operation: params.operation,
      tokensUsed: params.tokensUsed,
      platform: params.platform,
      inputSummary: params.inputSummary,
      outputLength: params.outputLength,
      success: params.success,
      errorMessage: params.errorMessage,
      apiInputTokens: params.apiInputTokens,
      apiOutputTokens: params.apiOutputTokens,
    });
  }

  /**
   * Reset monthly tokens (called when reset date is reached)
   */
  private async resetMonthlyTokens(
    workspaceId: string,
    newLimit: number,
  ): Promise<void> {
    const newResetDate = this.getNextResetDate();

    await this.db
      .update(workspaceUsage)
      .set({
        aiTokensUsedThisMonth: 0,
        aiTokensLimit: newLimit,
        aiTokensResetDate: newResetDate,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));

    // Log the reset event
    await this.db.insert(usageEvents).values({
      workspaceId,
      eventType: 'AI_TOKENS_RESET',
      resourceType: 'AI_TOKENS',
      quantityBefore: 0, // Doesn't matter for reset
      quantityAfter: 0,
      quantityDelta: 0,
      metadata: { newLimit, resetDate: newResetDate.toISOString() },
    });

    this.logger.log(`Reset AI tokens for workspace ${workspaceId}`);
  }

  /**
   * Get the next monthly reset date (first of next month)
   */
  private getNextResetDate(): Date {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth;
  }

  /**
   * Get AI usage statistics for a workspace
   */
  async getWorkspaceAiUsage(workspaceId: string) {
    const usage = await this.db.query.workspaceUsage.findFirst({
      where: eq(workspaceUsage.workspaceId, workspaceId),
    });

    if (!usage) {
      return {
        used: 0,
        limit: 0,
        extraPurchased: 0,
        remaining: 0,
        resetsAt: null,
      };
    }

    return {
      used: usage.aiTokensUsedThisMonth,
      limit: usage.aiTokensLimit,
      extraPurchased: usage.extraAiTokensPurchased,
      remaining: Math.max(
        0,
        usage.aiTokensLimit +
          usage.extraAiTokensPurchased -
          usage.aiTokensUsedThisMonth,
      ),
      resetsAt: usage.aiTokensResetDate,
    };
  }

  /**
   * Get recent AI usage logs for a workspace
   */
  async getRecentUsageLogs(workspaceId: string, limit: number = 20) {
    const logs = await this.db.query.aiUsageLog.findMany({
      where: eq(aiUsageLog.workspaceId, workspaceId),
      orderBy: (aiUsageLog, { desc }) => [desc(aiUsageLog.createdAt)],
      limit,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return logs;
  }

  /**
   * Add purchased tokens to workspace
   */
  async addPurchasedTokens(
    workspaceId: string,
    tokensToAdd: number,
    userId?: string,
  ): Promise<void> {
    await this.db
      .update(workspaceUsage)
      .set({
        extraAiTokensPurchased: sql`${workspaceUsage.extraAiTokensPurchased} + ${tokensToAdd}`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));

    // Log the purchase event
    await this.db.insert(usageEvents).values({
      workspaceId,
      eventType: 'AI_TOKENS_ADDON_ADDED',
      resourceType: 'AI_TOKENS',
      quantityBefore: 0,
      quantityAfter: tokensToAdd,
      quantityDelta: tokensToAdd,
      triggeredByUserId: userId,
      metadata: { tokensPurchased: tokensToAdd },
    });

    this.logger.log(
      `Added ${tokensToAdd} purchased tokens to workspace ${workspaceId}`,
    );
  }

  /**
   * Validate and execute an AI operation with token management
   * This is the main method to be called before any AI operation
   */
  async executeWithTokens<T>(
    workspaceId: string,
    userId: string,
    operation: string,
    platform: string | undefined,
    inputSummary: string,
    executeOperation: () => Promise<{ result: T; outputLength?: number }>,
  ): Promise<{ result: T; usage: TokenDeductResult }> {
    // Check tokens first
    const tokenCheck = await this.checkTokens(workspaceId, operation);

    if (!tokenCheck.hasAccess) {
      // Log failed attempt
      await this.logUsage({
        workspaceId,
        userId,
        operation,
        tokensUsed: 0,
        platform,
        inputSummary,
        success: false,
        errorMessage: tokenCheck.message,
      });

      if (tokenCheck.monthlyLimit === 0) {
        throw new ForbiddenException(tokenCheck.message);
      }
      throw new BadRequestException(tokenCheck.message);
    }

    try {
      // Execute the AI operation
      const { result, outputLength } = await executeOperation();

      // Deduct tokens
      const deductResult = await this.deductTokens(
        workspaceId,
        userId,
        operation,
      );

      // Log successful usage
      await this.logUsage({
        workspaceId,
        userId,
        operation,
        tokensUsed: this.getOperationCost(operation),
        platform,
        inputSummary,
        outputLength,
        success: true,
      });

      return { result, usage: deductResult };
    } catch (error) {
      // Log failed operation (don't deduct tokens on failure)
      await this.logUsage({
        workspaceId,
        userId,
        operation,
        tokensUsed: 0,
        platform,
        inputSummary,
        success: false,
        errorMessage: error.message,
      });

      throw error;
    }
  }
}
