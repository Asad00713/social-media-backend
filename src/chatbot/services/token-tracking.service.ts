import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { workspaceUsage, aiUsageLog } from '../../drizzle/schema/billing.schema';

export interface TokenBudgetStatus {
  used: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
  resetDate: Date | null;
}

export interface UsageSummary extends TokenBudgetStatus {
  extraPurchased: number;
}

@Injectable()
export class TokenTrackingService {
  private readonly logger = new Logger(TokenTrackingService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Check whether the workspace still has AI token budget remaining.
   */
  async checkBudget(workspaceId: string): Promise<TokenBudgetStatus> {
    const usage = await this.db.query.workspaceUsage.findFirst({
      where: eq(workspaceUsage.workspaceId, workspaceId),
    });

    if (!usage) {
      // No usage record = no plan configured, allow by default
      return { used: 0, limit: 0, remaining: 0, exceeded: false, resetDate: null };
    }

    const totalLimit = usage.aiTokensLimit + usage.extraAiTokensPurchased;
    const used = usage.aiTokensUsedThisMonth;
    const remaining = Math.max(0, totalLimit - used);

    // If limit is 0, treat as unlimited (no plan restriction)
    const exceeded = totalLimit > 0 && used >= totalLimit;

    return {
      used,
      limit: totalLimit,
      remaining,
      exceeded,
      resetDate: usage.aiTokensResetDate,
    };
  }

  /**
   * Record token usage after a successful AI operation.
   * Increments the workspace counter and inserts a log entry.
   */
  async recordUsage(
    workspaceId: string,
    userId: string,
    tokensUsed: number,
    operation: string,
    details?: {
      apiInputTokens?: number;
      apiOutputTokens?: number;
      inputSummary?: string;
      outputLength?: number;
    },
  ): Promise<void> {
    if (tokensUsed <= 0) return;

    try {
      // Atomic increment to avoid race conditions
      await this.db
        .update(workspaceUsage)
        .set({
          aiTokensUsedThisMonth: sql`${workspaceUsage.aiTokensUsedThisMonth} + ${tokensUsed}`,
        })
        .where(eq(workspaceUsage.workspaceId, workspaceId));

      // Insert detailed log entry
      await this.db.insert(aiUsageLog).values({
        workspaceId,
        userId,
        operation,
        tokensUsed,
        apiInputTokens: details?.apiInputTokens,
        apiOutputTokens: details?.apiOutputTokens,
        inputSummary: details?.inputSummary,
        outputLength: details?.outputLength,
        success: true,
      });
    } catch (error) {
      this.logger.error(`Failed to record token usage: ${error}`);
    }
  }

  /**
   * Get a full usage summary for the workspace.
   */
  async getUsageSummary(workspaceId: string): Promise<UsageSummary> {
    const usage = await this.db.query.workspaceUsage.findFirst({
      where: eq(workspaceUsage.workspaceId, workspaceId),
    });

    if (!usage) {
      return {
        used: 0,
        limit: 0,
        extraPurchased: 0,
        remaining: 0,
        exceeded: false,
        resetDate: null,
      };
    }

    const totalLimit = usage.aiTokensLimit + usage.extraAiTokensPurchased;
    const used = usage.aiTokensUsedThisMonth;
    const remaining = Math.max(0, totalLimit - used);
    const exceeded = totalLimit > 0 && used >= totalLimit;

    return {
      used,
      limit: totalLimit,
      extraPurchased: usage.extraAiTokensPurchased,
      remaining,
      exceeded,
      resetDate: usage.aiTokensResetDate,
    };
  }
}
