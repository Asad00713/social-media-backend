import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceBrandProfiles } from '../drizzle/schema/workspace-brand-profile.schema';
import {
  extractPageMeta,
  fetchPublicHtml,
} from '../media-library/lib/link-meta';
import { AiTextService } from './ai-text.service';
import { ClaudeTextService } from './claude-text.service';
import { AiTokenService, TokenDeductResult } from './services/ai-token.service';
import {
  ensureLink,
  factLines,
  fillBlanksPrompt,
  finishPrompt,
  fitPrompt,
  groundedValues,
  joinContinuation,
  linkPrompt,
  type BlankFacts,
  type ComposerPlatform,
} from './lib/composer-assist';

export interface FitChannel {
  platform: ComposerPlatform;
  maxChars: number;
}

export interface FitVariation {
  platform: ComposerPlatform;
  text: string;
  /** The model went past the channel's limit; the card's counter will show it. */
  isOverLimit: boolean;
}

/** Sent to the page we read: says who is asking, like the link library does. */
const LINK_USER_AGENT =
  'Mozilla/5.0 (compatible; SocialMediaBot/1.0; +https://example.com)';

/**
 * The composer's own Maestro actions that no older endpoint covered.
 *
 * Claude Haiku through the Messages API when ANTHROPIC_API_KEY is set; the
 * shared AiTextService (Gemini, then Groq) otherwise, so a deployment without
 * the key keeps working. Each action is ONE metered unit through
 * AiTokenService.executeWithTokens: nothing is charged when the model call
 * fails, or when the request is refused before it (an unreadable link).
 */
@Injectable()
export class ComposerAssistService {
  private readonly logger = new Logger(ComposerAssistService.name);

  constructor(
    private readonly claude: ClaudeTextService,
    private readonly aiText: AiTextService,
    private readonly aiTokens: AiTokenService,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  async finishDraft(
    workspaceId: string,
    userId: string,
    input: { caption: string; platform?: ComposerPlatform; maxChars?: number },
  ): Promise<{ content: string; usage: TokenDeductResult }> {
    const { system, user } = finishPrompt(input);
    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'finish_draft',
      input.platform,
      `Finish draft: ${input.caption.substring(0, 80)}`,
      async () => {
        const reply = await this.complete(system, user);
        const content = joinContinuation(input.caption, reply);
        return { result: content, outputLength: content.length };
      },
    );
    return { content: result, usage };
  }

  async fitChannels(
    workspaceId: string,
    userId: string,
    input: { caption: string; channels: FitChannel[] },
  ): Promise<{ variations: FitVariation[]; usage: TokenDeductResult }> {
    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'fit_channels',
      // The log column is 30 characters; a list of platforms overflows it.
      undefined,
      `Fit ${input.channels.length} channel(s): ${input.caption.substring(0, 60)}`,
      async () => {
        const variations = await Promise.all(
          input.channels.map(async ({ platform, maxChars }) => {
            const { system, user } = fitPrompt({
              caption: input.caption,
              platform,
              maxChars,
            });
            const text = (await this.complete(system, user)).trim();
            if (!text) {
              throw new BadGatewayException(
                'Maestro returned nothing for one channel. Please try again.',
              );
            }
            return { platform, text, isOverLimit: text.length > maxChars };
          }),
        );
        return {
          result: variations,
          outputLength: variations.reduce((n, v) => n + v.text.length, 0),
        };
      },
    );
    return { variations: result, usage };
  }

  async postFromLink(
    workspaceId: string,
    userId: string,
    input: { url: string; platform?: ComposerPlatform; maxChars?: number },
  ): Promise<{
    content: string;
    page: { url: string; title?: string; description?: string };
    usage: TokenDeductResult;
  }> {
    // Read before metering: a page we cannot read costs nothing.
    const page = await this.readPage(input.url);
    if (!page.title && !page.description) {
      throw new UnprocessableEntityException(
        'That page has no title or description to write from.',
      );
    }
    const { system, user } = linkPrompt({ ...input, ...page });
    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'link_to_post',
      input.platform,
      `Post from link: ${input.url.substring(0, 80)}`,
      async () => {
        const content = ensureLink(
          await this.complete(system, user),
          input.url,
        );
        return { result: content, outputLength: content.length };
      },
    );
    return {
      content: result,
      page: {
        url: input.url,
        title: page.title,
        description: page.description,
      },
      usage,
    };
  }

  async fillBlanks(
    workspaceId: string,
    userId: string,
    input: { caption: string; blanks: string[] },
  ): Promise<{
    values: Record<string, string>;
    left: string[];
    usage: TokenDeductResult;
  }> {
    const blanks = [...new Set(input.blanks)];
    const facts = factLines(await this.loadFacts(workspaceId));
    const { system, user } = fillBlanksPrompt({
      caption: input.caption,
      blanks,
      facts,
    });
    const { result, usage } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'fill_blanks',
      undefined,
      `Fill ${blanks.length} blank(s)`,
      async () => {
        const reply = await this.complete(system, user);
        const filled = groundedValues({
          reply,
          blanks,
          sources: [input.caption, ...facts],
        });
        return {
          result: filled,
          outputLength: Object.values(filled.values).join('').length,
        };
      },
    );
    return { ...result, usage };
  }

  private complete(system: string, user: string): Promise<string> {
    return this.claude.isReady()
      ? this.claude.complete(system, user)
      : this.aiText.complete(system, user, { maxTokens: 1024 });
  }

  private async readPage(url: string): Promise<{
    title?: string;
    description?: string;
    siteName?: string;
  }> {
    let page: { html: string; finalUrl: string } | null = null;
    try {
      page = await fetchPublicHtml(url, { 'User-Agent': LINK_USER_AGENT });
    } catch (err) {
      this.logger.warn(
        `Link read failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!page) {
      throw new UnprocessableEntityException(
        'That page could not be read. Check the link and try again.',
      );
    }
    const meta = extractPageMeta(page.html, page.finalUrl);
    return {
      title: meta.title?.trim() || undefined,
      description: meta.description?.trim() || undefined,
      siteName: meta.siteName?.trim() || undefined,
    };
  }

  /**
   * What the workspace already states about itself. A failed read is no
   * facts, not a 500: the blanks are then left, which is the safe answer.
   */
  private async loadFacts(workspaceId: string): Promise<BlankFacts> {
    try {
      const [ws] = await this.db
        .select({ name: workspace.name, description: workspace.description })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .limit(1);
      const [brand] = await this.db
        .select({
          sells: workspaceBrandProfiles.sells,
          audience: workspaceBrandProfiles.audience,
          voice: workspaceBrandProfiles.voice,
        })
        .from(workspaceBrandProfiles)
        .where(eq(workspaceBrandProfiles.workspaceId, workspaceId))
        .limit(1);
      return {
        workspaceName: ws?.name,
        workspaceDescription: ws?.description,
        sells: brand?.sells,
        audience: brand?.audience,
        voice: brand?.voice ?? [],
      };
    } catch (err) {
      this.logger.warn(
        `Workspace facts unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return {};
    }
  }
}
