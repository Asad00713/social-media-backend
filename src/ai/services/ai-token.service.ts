import {
  Injectable,
  Logger,
  Inject,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { getNextTokenResetDate } from '../../billing/services/token-reset.util';
import {
  workspace,
  workspaceUsage,
  subscriptions,
  plans,
  aiUsageLog,
  usageEvents,
} from '../../drizzle/schema';
import { and, eq, sql } from 'drizzle-orm';
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';

// Token costs per operation.
//
// These are CREDITS, not Anthropic tokens: a fixed price per operation, which
// is why the numbers are small and round. The real API usage is recorded on
// `ai_usage_log` (apiInputTokens/apiOutputTokens) but never drives the
// deduction. That keeps a user's balance predictable, and it puts the burden
// on this table to stay in line with what each operation actually costs us.
//
// What every credit is worth, measured 2026-11-20: a text operation runs on
// Haiku 5.5 ($0.10/$0.50 per MTok) and costs us about $0.000054 per credit.
// Keep new operations near that figure, or they are priced wrong.
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
  suggest_reply: 5, // one inbox reply draft
  first_week_draft: 5, // one drafted post of the Home "first week"
  finish_draft: 5, // composer Maestro: continue a half-written caption
  link_to_post: 5, // composer Maestro: a post from a page's title/description
  fill_blanks: 5, // composer Maestro: template {{blanks}} from stated facts
  // Tier 3 - Advanced (8 tokens)
  generate_ideas: 8,
  generate_youtube_metadata: 8,
  generate_variations: 8,
  generate_caption_variants: 8, // 1–4 captions from one idea, billed as one unit
  analyze_post: 8,
  generate_per_channel: 8,
  fit_channels: 8, // composer Maestro: one caption adapted per channel, one unit
  brand_learn: 8, // read a brand's posts into a one-line profile (Home first week)
  // Tier 4 - Complex (10 tokens)
  generate_thread: 10,
  // Tier 5 - Premium (15 tokens per platform)
  generate_drip_content: 15,
  // Tier 6 - Vision (200 tokens)
  //
  // Alt text is the one operation that sends an IMAGE to a vision model, and
  // it is two orders of magnitude more expensive than any text operation:
  //
  //   - the model is Sonnet 5.5, not Haiku 5.5 — 20x the per-token price
  //     (alt-text.service.ts picks Claude whenever ANTHROPIC_API_KEY is set,
  //     so this is the production path, not a fallback)
  //   - the image itself is ~800–1,400 input tokens. Claude charges
  //     (width x height) / 750, and Cloudinary caps the long edge at 1024
  //     (`vision.ts`), so a square photo alone is ~1,400 tokens before the
  //     prompt
  //   - `max_tokens` is 2048 to leave room for the model's thinking, which
  //     bills as output
  //
  // Measured worst case: ~$0.0121 per description. At the old price of 2
  // credits that was ~$0.00011 charged — undercharging by about 112x, so a
  // Basic workspace spending its whole allowance on alt text cost us $33
  // against $5 of revenue. Bulk media upload reaches that honestly.
  //
  // 200 credits puts it back in line with every other operation. If this ever
  // needs to be cheaper for users, move it to Haiku 5.5 (~12 credits) and
  // accept weaker descriptions — but alt text is an accessibility feature
  // read by people who cannot see the image, so quality is the point.
  generate_alt_text: 200,
  // Tier 7 - Audio (200 tokens)
  //
  // Transcription is billed by the MINUTE by the provider, not by the token,
  // which is why it does not belong in the text tiers either. ElevenLabs
  // Scribe is $0.20 per hour of audio, and `elevenlabs-stt.service.ts` caps a
  // clip at 180 seconds, so the worst case is 3 minutes = $0.010 per call —
  // 37x what 5 credits were worth. A Basic workspace spending its allowance
  // on voice input cost us $20 against $5 of revenue.
  //
  // Priced at the cap rather than per second: the service already refuses
  // anything over 3 minutes, so this is a real ceiling, and a flat price is
  // what makes a credit balance predictable. It does mean a 20-second note
  // costs the same as a 3-minute one; if that proves unpopular, charge
  // per 30 seconds of `durationSeconds` (which the service already receives)
  // instead of adding a second flat tier.
  speech_to_text: 200,
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
   * The account that pays for this workspace. Null when the workspace is gone,
   * which the caller treats the same as having no subscription.
   */
  private async resolveOwnerId(workspaceId: string): Promise<string | null> {
    const row = await this.db.query.workspace.findFirst({
      where: and(eq(workspace.id, workspaceId), liveWorkspaces()),
      columns: { ownerId: true },
    });
    return row?.ownerId ?? null;
  }

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

    // Subscriptions are account-scoped: the plan covering this workspace is
    // its owner's. Resolve the owner first, then read their one subscription.
    const ownerId = await this.resolveOwnerId(workspaceId);

    const subscription = ownerId
      ? await this.db.query.subscriptions.findFirst({
          where: eq(subscriptions.userId, ownerId),
          with: {
            plan: true,
          },
        })
      : null;

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
        message:
          'Your plan does not include AI features. Please upgrade to Pro or Max.',
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
          storageBytesLimit: plan.storageBytesPerWorkspace,
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
   * Get the next monthly reset date (first of next month).
   *
   * Delegates so that this service and the four billing/workspace insert sites
   * cannot drift apart on what "next cycle" means.
   */
  private getNextResetDate(): Date {
    return getNextTokenResetDate();
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
