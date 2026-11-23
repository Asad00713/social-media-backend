import { Injectable } from '@nestjs/common';
import { GroqService } from './groq.service';
import { AiTextService } from './ai-text.service';
import { AiTokenService, TokenDeductResult } from './services/ai-token.service';
import type { Platform, Tone } from './dto/ai.dto';
import { BrandVoiceService } from '../brand-voice/brand-voice.service';
import {
  brandVoicePrompt,
  hashtagsWanted,
} from '../brand-voice/lib/brand-voice-prompt';

export interface GeneratePerChannelInput {
  description: string;
  platforms: Platform[];
  tone?: Tone;
  includeHashtags?: boolean;
}

export interface GenerateCaptionVariantsInput {
  description: string;
  platform: Platform;
  tone?: Tone;
  count: number;
}

export interface GenerateCaptionVariantsResult {
  variants: string[];
  usage: TokenDeductResult;
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
    private readonly brandVoice: BrandVoiceService,
  ) {}

  async generatePerChannel(
    workspaceId: string,
    userId: string,
    input: GeneratePerChannelInput,
  ): Promise<GeneratePerChannelResult> {
    const { description, platforms, tone, includeHashtags } = input;

    // One read for the whole fan-out, before metering: a voice read is never
    // charged, and never fails.
    const source = await this.brandVoice.loadPromptSource(workspaceId);

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
              // The request wins; otherwise the voice decides (undefined with
              // no voice, which the prompt reads as "no hashtags", as before).
              includeHashtags: includeHashtags ?? hashtagsWanted(source.voice),
              includeCta: true,
              // Each channel gets its own tweak.
              voice: brandVoicePrompt({ ...source, platform }),
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

  /**
   * Generate `count` distinct captions from one idea, routed through
   * AiTextService (Gemini primary, Groq fallback) for quality — unlike the
   * Groq-only GroqService.generateCaptionVariants. Metered as one billable
   * unit regardless of count.
   */
  async generateCaptionVariants(
    workspaceId: string,
    userId: string,
    input: GenerateCaptionVariantsInput,
  ): Promise<GenerateCaptionVariantsResult> {
    const { description, platform, tone, count } = input;

    const source = await this.brandVoice.loadPromptSource(workspaceId);
    const voice = brandVoicePrompt({ ...source, platform });

    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'generate_caption_variants',
      platform,
      `${count} caption(s) for: ${description.substring(0, 80)}`,
      async () => {
        const { system, user } = this.groq.buildCaptionVariantsPrompt({
          description,
          platform,
          tone,
          count,
          voice,
        });
        // ~400 tokens headroom per caption so long platforms don't truncate.
        const raw = await this.aiText.complete(system, user, {
          maxTokens: Math.min(4096, 512 + count * 400),
        });
        const variants = this.groq.parseNumberedList(raw, count);
        return {
          result: { variants },
          outputLength: variants.join('').length,
        };
      },
    );

    return { ...result, usage };
  }
}
