import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { ConversationService } from '../../chatbot/services/conversation.service';
import { TokenTrackingService } from '../../chatbot/services/token-tracking.service';
import { GroqService } from '../../ai/groq.service';
import { PexelsService } from '../../pexels/pexels.service';
import { UnsplashService } from '../../channels/services/unsplash.service';
import { TavilyService } from '../../ai/services/tavily.service';
import { DiscordService } from '../../channels/services/discord.service';
import { SlackService } from '../../channels/services/slack.service';
import { InboxService } from '../../inbox/inbox.service';
import { PostService } from '../../posts/services/post.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { ClaudeAgentSdkRuntime } from '../runtime/claude-agent-sdk.runtime';
import { createUserTools } from '../tools/user.tools';
import { createMediaTools } from '../tools/media.tools';
import { createInteractionTools } from '../tools/interaction.tools';
import { createWebTools } from '../tools/web.tools';
import { createDiscordTools } from '../tools/discord.tools';
import { createSlackTools } from '../tools/slack.tools';
import { createTelegramTools } from '../tools/telegram.tools';
import { createWhatsAppTools } from '../tools/whatsapp.tools';
import { createPostTools } from '../tools/post.tools';
import { resolveAgentAuth } from '../auth/agent-auth';
import {
  STATIC_SYSTEM_PROMPT,
  CONFIRM_BEFORE_SEND_POLICY,
} from '../prompt/system-prompt';
import type {
  AgentRunInput,
  ConversationTurn,
  MaestroAttachment,
  ToolContext,
} from '../maestro.types';
import {
  MAESTRO_IMAGE_MIME,
  MAESTRO_IMAGE_MAX_BYTES,
  MAESTRO_PDF_MIME,
  MAESTRO_PDF_MAX_BYTES,
  type MaestroAttachmentKind,
} from '../dto/send-message.dto';

const DEFAULT_MODEL = process.env.MAESTRO_MODEL || 'claude-haiku-4-5';
const ALLOWED_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-6']);
const HISTORY_LIMIT = 20;
/**
 * The agent meters REAL Anthropic tokens (a turn easily costs 1,000+). We bill
 * the workspace at 1 user token per 100 real agent tokens, so a 1,000-token turn
 * deducts 10. Plan/add-on allowances (and the meter) are denominated in these
 * user tokens — stored 1:1 in workspaceUsage and shown as-is. The 100:1 ratio is
 * applied at RECORD time (real → user tokens), NOT at display.
 */
const AGENT_TOKENS_PER_USER_TOKEN = 100;
/** Sentinel the model emits before its follow-up suggestions (stripped from UI text). */
const FOLLOWUPS_MARKER = '__FOLLOWUPS__';

/** SSE events the controller writes to the client. */
export type MaestroSseEvent =
  | { event: 'thinking'; data: { text: string } }
  | { event: 'tool_executing'; data: { tool: string; input: unknown } }
  | {
      event: 'tool_result';
      data: { tool: string; output: unknown; isError: boolean };
    }
  | { event: 'message_stream'; data: { token: string } }
  | { event: 'message_complete'; data: { content: string; messageId: string } }
  | { event: 'followups'; data: { suggestions: string[] } }
  | { event: 'title'; data: { title: string } }
  | {
      event: 'done';
      data: {
        usage: { inputTokens: number; outputTokens: number; costUsd: number };
        budget: MaestroBudget;
      };
    }
  | { event: 'error'; data: { message: string } };

/** AI budget snapshot (in credits) surfaced to the UI meter. */
export interface MaestroBudget {
  /** Credits consumed this period (1 credit = 100 raw tokens). */
  used: number;
  /** Credit allowance for the period. */
  limit: number;
  /** Credits remaining (never negative). */
  remaining: number;
  /** True once the raw-token budget is exhausted. */
  exceeded: boolean;
  /** ISO string; null when no monthly reset is configured. */
  resetDate: string | null;
}

/** One question (confirm card or ask_user) surfaced from a headless turn. */
export interface HeadlessQuestionItem {
  header: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface HeadlessQuestionSet {
  questions: HeadlessQuestionItem[];
}

export interface HeadlessMediaItem {
  url: string;
  title?: string;
}

/** Result of a headless turn — text plus any question/media the agent emitted. */
export interface HeadlessTurnResult {
  text: string;
  question?: HeadlessQuestionSet;
  media?: HeadlessMediaItem[];
}

/**
 * Orchestrates one Maestro chat turn: authorize → persist user message → replay
 * history → run the agent runtime → translate `AgentEvent`s to SSE → persist the
 * assistant message. Persistence reuses the existing chatbot conversation
 * tables (stateless DB-replay).
 */
@Injectable()
export class MaestroService {
  private readonly logger = new Logger(MaestroService.name);

  constructor(
    private readonly runtime: ClaudeAgentSdkRuntime,
    private readonly conversations: ConversationService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
    private readonly tokens: TokenTrackingService,
    private readonly groq: GroqService,
    private readonly pexels: PexelsService,
    private readonly unsplash: UnsplashService,
    private readonly tavily: TavilyService,
    private readonly discord: DiscordService,
    private readonly slack: SlackService,
    private readonly posts: PostService,
    private readonly inbox: InboxService,
    private readonly r2: CloudflareR2Service,
  ) {}

  /**
   * Issue a presigned R2 upload URL for a chat attachment, enforcing Maestro's
   * stricter type/size caps (well under Claude's hard limits) before delegating
   * to the shared R2 service. Images go under the R2 'image' kind, PDFs under
   * 'file'.
   */
  async presignAttachment(
    userId: string,
    dto: {
      workspaceId: string;
      kind: MaestroAttachmentKind;
      contentType: string;
      sizeBytes: number;
      filename?: string;
    },
  ) {
    const { workspaceId, kind, contentType, sizeBytes, filename } = dto;
    if (kind === 'image') {
      if (!MAESTRO_IMAGE_MIME.includes(contentType as never)) {
        throw new BadRequestException(
          'Unsupported image type. Use JPEG, PNG, GIF, or WebP.',
        );
      }
      if (sizeBytes > MAESTRO_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Image is too large (max 4 MB).');
      }
      return this.r2.createPresignedUpload({
        workspaceId,
        userId,
        kind: 'image',
        contentType,
        sizeBytes,
        filename,
      });
    }
    // pdf
    if (contentType !== MAESTRO_PDF_MIME) {
      throw new BadRequestException('Only PDF files are supported.');
    }
    if (sizeBytes > MAESTRO_PDF_MAX_BYTES) {
      throw new BadRequestException('PDF is too large (max 15 MB).');
    }
    return this.r2.createPresignedUpload({
      workspaceId,
      userId,
      kind: 'file',
      contentType,
      sizeBytes,
      filename,
    });
  }

  /** Record a 👍/👎 on an assistant message (owner-checked). */
  async setFeedback(
    messageId: string,
    userId: string,
    feedback: 'good' | 'bad' | null,
  ) {
    await this.conversations.setMessageFeedback(messageId, userId, feedback);
    return { ok: true };
  }

  /**
   * Current AI budget for a workspace, in user tokens (the unit shown on the
   * meter). Stored 1:1 — the 100:1 real→user conversion already happened when
   * usage was recorded, so no division here.
   */
  async getUsage(workspaceId: string): Promise<MaestroBudget> {
    const s = await this.tokens.getUsageSummary(workspaceId);
    return {
      used: s.used,
      limit: s.limit,
      remaining: Math.max(0, s.limit - s.used),
      exceeded: s.exceeded,
      resetDate: s.resetDate ? s.resetDate.toISOString() : null,
    };
  }

  async createConversation(userId: string, workspaceId: string, title?: string) {
    return this.conversations.create(userId, workspaceId, title);
  }

  /** Conversations for the history list (most-recent first). */
  async listConversations(userId: string, workspaceId: string) {
    return this.conversations.list(userId, workspaceId);
  }

  /**
   * Run one turn HEADLESS (no SSE) — for the external bridge (Telegram/WhatsApp).
   * Reuses `streamMessage` so history replay, budget enforcement, tool wiring and
   * persistence are identical to the in-app path; we just collect the result
   * instead of streaming it. Confirm-before-send defaults ON (unattended
   * surface). Captures any question (confirm card / ask_user) and media so the
   * channel can render buttons / image previews.
   */
  async runHeadlessTurn(params: {
    conversationId: string;
    userId: string;
    message: string;
    confirmBeforeSend?: boolean;
    sourceChannel?: 'telegram' | 'whatsapp';
    /** Fired the instant the inbound user turn is persisted (before the reply). */
    onUserMessagePersisted?: () => void;
  }): Promise<HeadlessTurnResult> {
    const controller = new AbortController();
    let streamed = '';
    let final = '';
    let question: HeadlessQuestionSet | undefined;
    let media: HeadlessMediaItem[] | undefined;
    for await (const ev of this.streamMessage(
      {
        conversationId: params.conversationId,
        userId: params.userId,
        message: params.message,
        confirmBeforeSend: params.confirmBeforeSend ?? true,
        sourceChannel: params.sourceChannel,
        onUserMessagePersisted: params.onUserMessagePersisted,
      },
      controller.signal,
    )) {
      if (ev.event === 'message_stream') {
        streamed += ev.data.token;
      } else if (ev.event === 'message_complete') {
        final = ev.data.content;
      } else if (ev.event === 'tool_result' && !ev.data.isError) {
        const data = this.parseToolPayload(ev.data.output);
        if (!data) continue;
        if (data.kind === 'question') {
          const qs = this.normalizeHeadlessQuestions(data);
          if (qs) question = qs;
        } else if (data.kind === 'media' && Array.isArray(data.items)) {
          const items = (data.items as Record<string, unknown>[])
            .map((it) => ({
              url: String(it.url ?? it.src ?? ''),
              title: it.title ? String(it.title) : undefined,
            }))
            .filter((it) => it.url);
          if (items.length) media = items;
        }
      } else if (ev.event === 'error') {
        return {
          text:
            (final || streamed).trim() ||
            "Sorry — I hit an error and couldn't finish that.",
          question,
          media,
        };
      }
    }
    return { text: (final || streamed).trim(), question, media };
  }

  /** Normalize an ask_user / confirm-card payload into a headless question set. */
  private normalizeHeadlessQuestions(
    data: Record<string, unknown>,
  ): HeadlessQuestionSet | null {
    const raw = Array.isArray(data.questions) ? data.questions : [];
    const questions = (raw as Record<string, unknown>[])
      .map((q) => {
        const question = String(q.question ?? '').trim();
        const options = Array.isArray(q.options)
          ? (q.options as unknown[]).map(String).filter(Boolean)
          : [];
        const header = String(q.header ?? '').trim() || question.slice(0, 24);
        return {
          header,
          question,
          options,
          multiSelect: Boolean(q.multiSelect),
        };
      })
      .filter((q) => q.question && q.options.length > 0);
    return questions.length ? { questions } : null;
  }

  /** Tool results arrive as MCP content blocks: [{ type:'text', text:'<json>' }]. */
  private parseToolPayload(output: unknown): Record<string, unknown> | null {
    if (!Array.isArray(output)) return null;
    const block = output.find(
      (b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text',
    ) as { text?: string } | undefined;
    if (!block?.text) return null;
    try {
      return JSON.parse(block.text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Past messages of a conversation the caller owns (for replaying history). */
  async getConversationMessages(conversationId: string, userId: string) {
    const conversation = await this.conversations.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new ForbiddenException('Not your conversation');
    }
    return this.conversations.getMessages(conversationId);
  }

  async *streamMessage(
    params: {
      conversationId: string;
      userId: string;
      message: string;
      model?: string;
      /** When not explicitly false, the agent confirms before outward sends. */
      confirmBeforeSend?: boolean;
      /** When explicitly false, the web_search tool is withheld this turn. */
      webSearch?: boolean;
      /** Files (images/PDF) attached to this turn. */
      attachments?: MaestroAttachment[];
      /** External channel this turn came from (bridge), if any. */
      sourceChannel?: 'telegram' | 'whatsapp';
      /** Fired the instant the inbound user turn is persisted (before the model
       *  runs) — bridge channels use this to push the user bubble live. */
      onUserMessagePersisted?: () => void;
    },
    signal: AbortSignal,
  ): AsyncGenerator<MaestroSseEvent> {
    const { conversationId, userId, message } = params;
    const attachments =
      params.attachments && params.attachments.length > 0
        ? params.attachments
        : undefined;
    const confirmBeforeSend = params.confirmBeforeSend !== false;
    const webSearchEnabled = params.webSearch !== false;
    const model =
      params.model && ALLOWED_MODELS.has(params.model)
        ? params.model
        : DEFAULT_MODEL;

    const conversation = await this.conversations.findById(conversationId);
    if (conversation.userId !== userId) {
      throw new ForbiddenException('Not your conversation');
    }
    const ctx: ToolContext = {
      userId,
      workspaceId: conversation.workspaceId,
    };

    // Block the turn up front if the workspace has exhausted its AI-token budget.
    const preBudget = await this.tokens.checkBudget(ctx.workspaceId);
    if (preBudget.exceeded) {
      yield {
        event: 'error',
        data: {
          message:
            "You've used all your AI tokens for this period. Upgrade your plan or wait for the monthly reset to continue.",
        },
      };
      return;
    }

    // Persist the user turn (with attachment + source metadata so the bubble
    // re-renders on reload), then load history (excluding the message just saved).
    const userMeta: Record<string, unknown> = {};
    if (attachments) userMeta.maestroAttachments = attachments;
    if (params.sourceChannel) userMeta.maestroSource = params.sourceChannel;
    await this.conversations.addMessage(
      conversationId,
      'user',
      message,
      Object.keys(userMeta).length > 0 ? userMeta : undefined,
    );
    // Signal listeners (bridge) that the user turn is now in the DB so an open
    // panel can show it immediately, without waiting for the model's reply.
    if (params.onUserMessagePersisted) {
      try {
        params.onUserMessagePersisted();
      } catch {
        // a notification hook must never break the turn
      }
    }
    const recent = await this.conversations.getRecentMessages(
      conversationId,
      HISTORY_LIMIT,
    );
    const history: ConversationTurn[] = recent
      .filter((m) => {
        if (m.role !== 'user' && m.role !== 'assistant') return false;
        if (m.content) return true;
        // Keep an image/file-only user turn (empty text) so its attachment URLs
        // still reach later turns.
        const atts = (
          m.metadata as { maestroAttachments?: unknown[] } | null
        )?.maestroAttachments;
        return m.role === 'user' && Array.isArray(atts) && atts.length > 0;
      })
      .slice(0, -1)
      .map((m) => {
        let content = (m.content ?? '').trim();
        // Surface a past message's attachment URLs in the replayed transcript so
        // the agent can still FORWARD them on a LATER turn — e.g. after a
        // confirm card, which runs as a fresh turn where the original file is no
        // longer attached. Without this, "send the image I attached" → confirm →
        // "Yes" loses the URL because history is replayed as plain text.
        const atts = (
          m.metadata as {
            maestroAttachments?: { name: string; url: string }[];
          } | null
        )?.maestroAttachments;
        if (m.role === 'user' && Array.isArray(atts) && atts.length > 0) {
          const list = atts.map((a) => `${a.name} — ${a.url}`).join('; ');
          const note = `[Attached files (URLs for tool use only, do not paste in replies): ${list}]`;
          content = content ? `${content}\n${note}` : note;
        }
        return { role: m.role as 'user' | 'assistant', content };
      });

    // First message in a fresh conversation → generate a title (Groq, concurrent
    // with the agent run so it adds no latency to the response stream).
    const isFirstTurn = history.length === 0 && !conversation.title;
    const titlePromise =
      isFirstTurn && this.groq.isReady()
        ? this.groq.generateConversationTitle(message).catch((err) => {
            this.logger.warn(`Title generation failed: ${err}`);
            return null;
          })
        : null;

    const auth = resolveAgentAuth();
    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort());

    const systemPrompt = confirmBeforeSend
      ? [STATIC_SYSTEM_PROMPT, CONFIRM_BEFORE_SEND_POLICY]
      : STATIC_SYSTEM_PROMPT;

    const input: AgentRunInput = {
      ctx,
      systemPrompt,
      history,
      userMessage: message,
      attachments,
      tools: [
        ...createUserTools(this.usersService, this.workspaceService),
        ...createMediaTools(this.unsplash, this.pexels),
        ...(webSearchEnabled ? createWebTools(this.tavily) : []),
        ...createDiscordTools(this.discord, this.inbox, { confirmBeforeSend }),
        ...createSlackTools(this.slack, this.inbox, { confirmBeforeSend }),
        ...createTelegramTools(this.inbox, { confirmBeforeSend }),
        ...createWhatsAppTools(this.inbox, { confirmBeforeSend }),
        ...createPostTools(this.posts, { confirmBeforeSend }),
        ...createInteractionTools(),
      ],
      model,
      env: auth.env,
      abortController,
    };

    // Streamed text is filtered for the trailing `__FOLLOWUPS__ a | b | c` line:
    // we hold back a possible partial marker at the tail so it never flashes in
    // the UI, then split the suggestions off into a separate `followups` event.
    let raw = '';
    let emittedLen = 0;
    let markerIdx = -1;
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    // Captured from tool results so we can persist them in message metadata
    // (otherwise media/questions would vanish on reload).
    let maestroMedia: {
      items: unknown[];
      selectable: boolean;
      maxSelect: number | null;
    } | null = null;
    let maestroQuestion: {
      questions: {
        header: string;
        question: string;
        options: string[];
        multiSelect: boolean;
      }[];
    } | null = null;
    let maestroWeb:
      | { title: string; url: string; content: string }[]
      | null = null;

    try {
      for await (const ev of this.runtime.run(input)) {
        if (signal.aborted) break;
        switch (ev.type) {
          case 'thinking_delta':
            yield { event: 'thinking', data: { text: ev.text } };
            break;
          case 'text_delta': {
            raw += ev.text;
            if (markerIdx !== -1) break; // everything after the marker is followups
            const idx = raw.indexOf(FOLLOWUPS_MARKER);
            if (idx !== -1) {
              markerIdx = idx;
              if (idx > emittedLen) {
                yield {
                  event: 'message_stream',
                  data: { token: raw.slice(emittedLen, idx) },
                };
                emittedLen = idx;
              }
            } else {
              // Don't emit the last (marker length - 1) chars: could be a partial marker.
              const safeEnd = Math.max(
                emittedLen,
                raw.length - (FOLLOWUPS_MARKER.length - 1),
              );
              if (safeEnd > emittedLen) {
                yield {
                  event: 'message_stream',
                  data: { token: raw.slice(emittedLen, safeEnd) },
                };
                emittedLen = safeEnd;
              }
            }
            break;
          }
          case 'tool_call':
            yield {
              event: 'tool_executing',
              data: { tool: ev.name, input: ev.input },
            };
            break;
          case 'tool_result': {
            const data = this.parseToolPayload(ev.output);
            if (data?.kind === 'media' && Array.isArray(data.items)) {
              maestroMedia = {
                items: data.items,
                selectable: Boolean(data.selectable),
                maxSelect: (data.maxSelect as number | null) ?? null,
              };
            } else if (
              data?.kind === 'question' &&
              Array.isArray(data.questions) &&
              data.questions.length > 0
            ) {
              maestroQuestion = {
                questions: data.questions.map((q) => {
                  const item = (q ?? {}) as Record<string, unknown>;
                  return {
                    header: String(item.header || ''),
                    question: String(item.question || ''),
                    options: Array.isArray(item.options)
                      ? item.options.map((o) => String(o))
                      : [],
                    multiSelect: Boolean(item.multiSelect),
                  };
                }),
              };
            } else if (data?.kind === 'web') {
              if (Array.isArray(data.images) && data.images.length > 0) {
                maestroMedia = {
                  items: data.images as unknown[],
                  selectable: false,
                  maxSelect: null,
                };
              }
              if (Array.isArray(data.results)) {
                maestroWeb = data.results as {
                  title: string;
                  url: string;
                  content: string;
                }[];
              }
            }
            yield {
              event: 'tool_result',
              data: { tool: ev.name, output: ev.output, isError: ev.isError },
            };
            break;
          }
          case 'done':
            usage = ev.usage;
            break;
          case 'error':
            yield { event: 'error', data: { message: ev.message } };
            return;
        }
      }

      // Flush any held-back display text when no marker was ever seen.
      if (markerIdx === -1 && raw.length > emittedLen) {
        yield { event: 'message_stream', data: { token: raw.slice(emittedLen) } };
      }

      const displayText = (
        markerIdx === -1 ? raw : raw.slice(0, markerIdx)
      ).trim();
      const followups =
        markerIdx === -1
          ? []
          : raw
              .slice(markerIdx + FOLLOWUPS_MARKER.length)
              .split('|')
              .map((s) => s.trim().replace(/^[-•\d.)\s]+/, '').trim())
              .filter(Boolean)
              .slice(0, 4);

      const metadata =
        maestroMedia || maestroQuestion || maestroWeb
          ? {
              ...(maestroMedia ? { maestroMedia } : {}),
              ...(maestroQuestion ? { maestroQuestion } : {}),
              ...(maestroWeb ? { maestroWeb } : {}),
            }
          : undefined;

      if (displayText || maestroMedia || maestroQuestion || maestroWeb) {
        const saved = await this.conversations.addMessage(
          conversationId,
          'assistant',
          displayText || null,
          metadata,
          model,
          usage.outputTokens,
        );
        yield {
          event: 'message_complete',
          data: { content: displayText, messageId: saved.id },
        };
      }
      // Meter the spend against the workspace budget. The agent's REAL token
      // spend is converted to user tokens at 100:1 (rounded up, min 1) so a
      // ~1,000-token turn costs 10. Raw counts are kept in the log details.
      const totalTokens = usage.inputTokens + usage.outputTokens;
      const billedTokens = Math.max(
        1,
        Math.ceil(totalTokens / AGENT_TOKENS_PER_USER_TOKEN),
      );
      await this.tokens.recordUsage(
        ctx.workspaceId,
        userId,
        billedTokens,
        'maestro_chat',
        {
          apiInputTokens: usage.inputTokens,
          apiOutputTokens: usage.outputTokens,
          outputLength: displayText.length,
        },
      );

      if (followups.length > 0) {
        yield { event: 'followups', data: { suggestions: followups } };
      }

      if (titlePromise) {
        const title = await titlePromise;
        if (title) {
          await this.conversations.updateTitle(conversationId, title);
          yield { event: 'title', data: { title } };
        }
      }

      const budget = await this.getUsage(ctx.workspaceId);
      yield { event: 'done', data: { usage, budget } };
    } catch (err) {
      if (signal.aborted) return;
      this.logger.error(`streamMessage failed: ${err}`);
      yield {
        event: 'error',
        data: {
          message: err instanceof Error ? err.message : 'Maestro failed',
        },
      };
    }
  }
}
