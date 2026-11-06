import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

/** Cheap and fast: the composer's text actions. */
export const CLAUDE_FAST_MODEL = 'claude-haiku-5-5';
/** Where quality matters more than cost: describing a photo. */
export const CLAUDE_VISION_MODEL = 'claude-sonnet-5-5';

/** The image formats the Messages API accepts as an image block. */
export const CLAUDE_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

export function isClaudeImageType(mime: string): mime is ClaudeImageType {
  return (CLAUDE_IMAGE_TYPES as readonly string[]).includes(mime);
}

interface CompleteOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * Single-shot Claude completions through the Messages API (never the Agent
 * SDK). One system prompt written in code, one user turn carrying the
 * caller's text as data — no conversation, no tools.
 *
 * Effort is `low`: these are short rewrites and one-line descriptions, and
 * the 5.5 models think by default. `max_tokens` has headroom for that
 * thinking, which counts against it. No `temperature`: the 5.5 models reject
 * non-default sampling values.
 */
@Injectable()
export class ClaudeTextService {
  private readonly logger = new Logger(ClaudeTextService.name);
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!apiKey) {
      this.logger.warn(
        'No ANTHROPIC_API_KEY - composer AI falls back to Gemini/Groq',
      );
    }
  }

  isReady(): boolean {
    return this.client !== null;
  }

  complete(
    system: string,
    user: string,
    opts: CompleteOptions = {},
  ): Promise<string> {
    return this.send({
      model: opts.model ?? CLAUDE_FAST_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });
  }

  describeImage(
    system: string,
    user: string,
    image: { mimeType: ClaudeImageType; data: string },
    opts: CompleteOptions = {},
  ): Promise<string> {
    return this.send({
      model: opts.model ?? CLAUDE_VISION_MODEL,
      max_tokens: opts.maxTokens ?? 2048,
      system,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mimeType,
                data: image.data,
              },
            },
            { type: 'text', text: user },
          ],
        },
      ],
    });
  }

  private async send(
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'output_config'>,
  ): Promise<string> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const response = await this.client.messages.create({
      ...params,
      output_config: { effort: 'low' },
    });
    if (response.stop_reason === 'refusal') {
      throw new BadGatewayException('Maestro could not help with this one.');
    }
    return response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
  }
}
