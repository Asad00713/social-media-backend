import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  workspaceUsage,
  aiUsageLog,
} from '../../drizzle/schema/billing.schema';

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
   *
   * A zero limit, or a workspace with no usage row at all, means NO budget —
   * not an unlimited one. Both used to return `exceeded: false`, which made
   * Maestro and the chatbot free and uncapped for any such workspace. That is
   * the most expensive thing in the app to give away: one Maestro message can
   * run up to 8 API calls at 16,000 max_tokens each.
   *
   * This now agrees with `AiTokenService.checkTokens`, which has always
   * refused on `plan.aiTokensPerMonth === 0` (`hasAccess: false`). The two
   * meters previously decided the same situation in opposite directions, and
   * the permissive one guarded the costlier feature.
   *
   * A missing row is a provisioning gap, not a plan: `workspace.service.ts`
   * writes one on create and `subscription.service.ts` on plan change, so in
   * practice only pre-dating workspaces lack one. Failing closed turns that
   * into a visible "out of credits" the owner can report, instead of silent
   * unmetered spend.
   */
  async checkBudget(workspaceId: string): Promise<TokenBudgetStatus> {
    const usage = await this.db.query.workspaceUsage.findFirst({
      where: eq(workspaceUsage.workspaceId, workspaceId),
    });

    if (!usage) {
      // No usage record = nothing has been provisioned for this workspace, so
      // there is no budget to spend. See the note above: this used to allow.
      return {
        used: 0,
        limit: 0,
        remaining: 0,
        exceeded: true,
        resetDate: null,
      };
    }

    const totalLimit = usage.aiTokensLimit + usage.extraAiTokensPurchased;
    const used = usage.aiTokensUsedThisMonth;
    const remaining = Math.max(0, totalLimit - used);

    // A zero limit is no budget, not an unlimited one.
    const exceeded = used >= totalLimit;

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
   *
   * Pass `billable: false` to LOG the usage without charging plan credits —
   * used by Maestro BYOK, where the workspace pays Anthropic directly. We still
   * want the log row for abuse detection, support ("how much have I used?") and
   * margin analysis; we just must not double-charge.
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
    options?: { billable?: boolean },
  ): Promise<void> {
    if (tokensUsed <= 0) return;
    const billable = options?.billable !== false;

    try {
      if (billable) {
        // Atomic increment to avoid race conditions
        await this.db
          .update(workspaceUsage)
          .set({
            aiTokensUsedThisMonth: sql`${workspaceUsage.aiTokensUsedThisMonth} + ${tokensUsed}`,
          })
          .where(eq(workspaceUsage.workspaceId, workspaceId));
      }

      // Insert detailed log entry
      await this.db.insert(aiUsageLog).values({
        workspaceId,
        userId,
        // Suffix un-billed rows so BYOK spend is separable from plan spend.
        operation: billable ? operation : `${operation}_byok`,
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
   *
   * `exceeded` here must mean the same thing it means in `checkBudget`, or the
   * usage meter in the UI tells the owner they have budget while the send path
   * refuses them (or the reverse).
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
        exceeded: true,
        resetDate: null,
      };
    }

    const totalLimit = usage.aiTokensLimit + usage.extraAiTokensPurchased;
    const used = usage.aiTokensUsedThisMonth;
    const remaining = Math.max(0, totalLimit - used);
    const exceeded = used >= totalLimit;

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
