import { Injectable } from '@nestjs/common';
import { GroqService } from './groq.service';
import { AiTextService } from './ai-text.service';
import { AiTokenService, TokenDeductResult } from './services/ai-token.service';
import type { Platform, Tone } from './dto/ai.dto';

export interface GeneratePerChannelInput {
  description: string;
  platforms: Platform[];
  tone?: Tone;
  includeHashtags?: boolean;
}

export interface PerChannelVariation {
  platform: Platform;
  text: string;
}

export interface GeneratePerChannelResult {
  variations: PerChannelVariation[];
  usage: TokenDeductResult;
}

/**
 * Orchestrates per-channel caption generation for the composer: one tailored
 * caption per platform, fanned out in parallel but metered as a SINGLE
 * billable AI operation (see AI_OPERATION_COSTS.generate_per_channel).
 */
@Injectable()
export class ComposerAiService {
  constructor(
    private readonly groq: GroqService,
    private readonly aiText: AiTextService,
    private readonly aiTokens: AiTokenService,
  ) {}

  async generatePerChannel(
    workspaceId: string,
    userId: string,
    input: GeneratePerChannelInput,
  ): Promise<GeneratePerChannelResult> {
    const { description, platforms, tone, includeHashtags } = input;

    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'generate_per_channel',
      platforms.join(','),
      `Per-channel: ${description.substring(0, 80)}`,
      async () => {
        const variations = await Promise.all(
          platforms.map(async (platform) => {
            const { system, user } = this.groq.buildCaptionPrompt({
              description,
              platform,
              tone,
              includeHashtags: !!includeHashtags,
              includeCta: true,
            });
            const text = await this.aiText.complete(system, user);
            return { platform, text };
          }),
        );
        return {
          result: { variations },
          outputLength: variations.map((v) => v.text).join('').length,
        };
      },
    );

    return { ...result, usage };
  }
}
