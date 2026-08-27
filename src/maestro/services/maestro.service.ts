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
import { MaestroKeyService } from './maestro-key.service';
import { createUserTools } from '../tools/user.tools';
import { isPendingAction, type PendingAction } from '../tools/confirm';
import { createMediaTools } from '../tools/media.tools';
import { createInteractionTools } from '../tools/interaction.tools';
import { createWebTools } from '../tools/web.tools';
import { createDiscordTools } from '../tools/discord.tools';
import { createSlackTools } from '../tools/slack.tools';
import { createTelegramTools } from '../tools/telegram.tools';
import { createWhatsAppTools } from '../tools/whatsapp.tools';
import { createPostTools } from '../tools/post.tools';
import {
  resolveAgentAuth,
  MaestroAuthUnavailableError,
} from '../auth/agent-auth';
import {
  STATIC_SYSTEM_PROMPT,
  CONFIRM_BEFORE_SEND_POLICY,
  bridgeChannelPolicy,
} from '../prompt/system-prompt';
import { z } from 'zod';
import type {
  AgentRunInput,
  AgentToolDefinition,
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

/** No model ran, so there is nothing to report. */
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Outward tools report failure as `{ ok: false, message }`. */
function isFailedToolResult(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === 'object' &&
      (result as { ok?: unknown }).ok === false,
  );
}

function failureMessage(result: unknown): string {
  const message = (result as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : 'the send failed.';
}
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
    private readonly keys: MaestroKeyService,
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

  /**
   * Maestro key + first-run state for a workspace. Owner-checked: the key is a
   * billing credential, so only the workspace owner may see or change it.
   * Returns only a MASKED hint — the key itself never leaves the server.
   */
  async getKeyStatus(userId: string, workspaceId: string) {
    await this.workspaceService.findOne(workspaceId, userId);
    return this.keys.getStatus(workspaceId);
  }

  /** Validate against Anthropic, then store the workspace's own key. */
  async setOwnKey(userId: string, workspaceId: string, apiKey: string) {
    await this.workspaceService.findOne(workspaceId, userId);
    return this.keys.setKey(workspaceId, apiKey);
  }

  /** Drop the workspace's key — Maestro reverts to the platform key. */
  async removeOwnKey(userId: string, workspaceId: string) {
    await this.workspaceService.findOne(workspaceId, userId);
    return this.keys.removeKey(workspaceId);
  }

  /** Mark the first-run Maestro wizard complete. */
  async completeOnboarding(userId: string, workspaceId: string) {
    await this.workspaceService.findOne(workspaceId, userId);
    return this.keys.markOnboarded(workspaceId);
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

  /**
   * The tool set for one turn. Shared by the agent run and the approval path,
   * so an approved action re-invokes the SAME handler the card came from —
   * built with the same options, not a lookalike.
   */
  private buildTools(opts: {
    confirmBeforeSend: boolean;
    webSearchEnabled: boolean;
  }): AgentToolDefinition[] {
    const { confirmBeforeSend, webSearchEnabled } = opts;
    return [
      ...createUserTools(this.usersService, this.workspaceService),
      ...createMediaTools(this.unsplash, this.pexels),
      ...(webSearchEnabled ? createWebTools(this.tavily) : []),
      ...createDiscordTools(this.discord, this.inbox, { confirmBeforeSend }),
      ...createSlackTools(this.slack, this.inbox, { confirmBeforeSend }),
      ...createTelegramTools(this.inbox, { confirmBeforeSend }),
      ...createWhatsAppTools(this.inbox, { confirmBeforeSend }),
      ...createPostTools(this.posts, { confirmBeforeSend }),
      ...createInteractionTools(),
    ];
  }

  /**
   * Perform the action a confirm card was waiting on.
   *
   * The card records which tool asked and with what (`pendingAction`), so the
   * approval re-invokes that handler directly. The model is never asked to
   * make the connection — it used to be, from chat text alone, and Haiku
   * routinely re-asked instead.
   *
   * Everything read back from metadata is treated as untrusted: the stored
   * arguments face the tool's own Zod schema before the handler sees them, and
   * `ctx` is rebuilt from the authenticated request, never from the payload.
   * A stored blob must not be usable as a capability.
   *
   * Returns null when the approval cannot be honoured, in which case the
   * caller falls back to a normal agent turn rather than failing the request.
   */
  private async resolveApproval(params: {
    approval: { messageId: string; option: string };
    conversationId: string;
    ctx: ToolContext;
    confirmBeforeSend: boolean;
    webSearchEnabled: boolean;
  }): Promise<{ approved: boolean; result?: unknown; tool?: string } | null> {
    const { approval, conversationId, ctx } = params;

    const recent = await this.conversations.getRecentMessages(
      conversationId,
      HISTORY_LIMIT,
    );
    // Scoped to THIS conversation, so a message id from elsewhere cannot be
    // used to trigger an action here.
    const message = recent.find((m) => m.id === approval.messageId);
    if (!message || message.role !== 'assistant') return null;

    const meta = message.metadata as {
      maestroQuestion?: { pendingAction?: unknown };
      maestroResolved?: unknown;
    } | null;
    // An approval must not be replayable.
    if (meta?.maestroResolved) return null;

    const pending = meta?.maestroQuestion?.pendingAction;
    if (!isPendingAction(pending)) return null;

    if (approval.option !== pending.yesLabel) {
      // Declined: nothing runs, and the card is closed so it cannot be
      // answered a second time.
      await this.conversations.setMessageMetadata(approval.messageId, {
        ...(meta ?? {}),
        maestroResolved: { approved: false, at: new Date().toISOString() },
      });
      return { approved: false };
    }

    const tool = this.buildTools({
      confirmBeforeSend: params.confirmBeforeSend,
      webSearchEnabled: params.webSearchEnabled,
    }).find((t) => t.name === pending.tool);
    if (!tool) return null;

    // Re-validate the stored arguments against the tool's own schema. They
    // have been through the database since they were captured.
    const parsed = z
      .object(tool.inputSchema as Record<string, z.ZodTypeAny>)
      .safeParse({ ...pending.args, confirmed: true });
    if (!parsed.success) {
      this.logger.warn(
        `Approval rejected: stored args failed ${pending.tool} schema`,
      );
      return null;
    }

    const result = await tool.handler(
      parsed.data as Record<string, unknown>,
      ctx,
    );
    await this.conversations.setMessageMetadata(approval.messageId, {
      ...(meta ?? {}),
      maestroResolved: { approved: true, at: new Date().toISOString() },
    });
    return { approved: true, result, tool: pending.tool };
  }

  /**
   * Emit the turn for an approval that was performed without the model.
   *
   * The events mirror a normal turn (tool_executing → tool_result → text →
   * complete → done) so the frontend needs no new event type, and the reply is
   * a short confirmation written here rather than generated — there is nothing
   * left to decide, and a model round-trip would only reintroduce the chance
   * of it re-asking.
   */
  private async *completeApprovalTurn(params: {
    conversationId: string;
    outcome: { approved: boolean; result?: unknown; tool?: string };
    model: string;
    userId: string;
    ctx: ToolContext;
    isByok: boolean;
  }): AsyncGenerator<MaestroSseEvent> {
    const { conversationId, outcome, model, userId, ctx } = params;

    if (!outcome.approved) {
      const text = 'No problem — I have not sent it.';
      const saved = await this.conversations.addMessage(
        conversationId,
        'assistant',
        text,
        undefined,
        model,
        0,
      );
      yield { event: 'message_stream', data: { token: text } };
      yield {
        event: 'message_complete',
        data: { content: text, messageId: saved.id },
      };
      yield { event: 'done', data: { usage: EMPTY_USAGE, budget: await this.getUsage(ctx.workspaceId) } };
      return;
    }

    const tool = outcome.tool ?? 'action';
    yield { event: 'tool_executing', data: { tool, input: {} } };
    const output = [
      { type: 'text', text: JSON.stringify(outcome.result ?? {}) },
    ];
    const failed = isFailedToolResult(outcome.result);
    yield {
      event: 'tool_result',
      data: { tool, output, isError: failed },
    };

    const text = failed
      ? `That did not go through: ${failureMessage(outcome.result)}`
      : 'Done — sent.';
    const saved = await this.conversations.addMessage(
      conversationId,
      'assistant',
      text,
      undefined,
      model,
      0,
    );
    yield { event: 'message_stream', data: { token: text } };
    yield {
      event: 'message_complete',
      data: { content: text, messageId: saved.id },
    };

    // The action ran on our infrastructure but without a model call, so there
    // are no agent tokens to convert. Logged at the floor so the turn still
    // appears in usage history.
    await this.tokens.recordUsage(
      ctx.workspaceId,
      userId,
      1,
      'maestro_chat',
      { apiInputTokens: 0, apiOutputTokens: 0, outputLength: text.length },
      { billable: !params.isByok },
    );

    yield {
      event: 'done',
      data: { usage: EMPTY_USAGE, budget: await this.getUsage(ctx.workspaceId) },
    };
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
      /** Set when this turn answers a confirm card rather than being typed. */
      approval?: { messageId: string; option: string };
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

    // Resolve the Anthropic credential BEFORE persisting anything. A
    // misconfigured deployment (no ANTHROPIC_API_KEY) must surface as a clean
    // error, not an uncaught throw mid-SSE that saves a user turn with no reply.
    // BYOK: when the workspace has its own Anthropic key, it pays Anthropic
    // directly, so this turn runs on that key and is NOT billed plan credits.
    const workspaceApiKey = await this.keys.getDecryptedKey(ctx.workspaceId);
    let auth: ReturnType<typeof resolveAgentAuth>;
    try {
      auth = resolveAgentAuth({ workspaceApiKey });
    } catch (err) {
      if (err instanceof MaestroAuthUnavailableError) {
        this.logger.error(`Maestro auth unavailable: ${err.message}`);
        yield {
          event: 'error',
          data: {
            message:
              "Maestro isn't configured on this server yet. Please contact support.",
          },
        };
        return;
      }
      throw err;
    }

    // Block the turn up front if the workspace has exhausted its AI-token
    // budget. A BYOK workspace is exempt: plan credits are not what pays for
    // its turns, so its own key must keep working past the plan allowance.
    const preBudget = await this.tokens.checkBudget(ctx.workspaceId);
    if (preBudget.exceeded && auth.keySource !== 'byok') {
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
    // An answer to a confirm card is performed HERE, not by the model. The
    // card recorded which tool asked and with what, so the approval re-invokes
    // that handler directly — the model used to have to infer the link from
    // chat text, and would re-ask instead of acting.
    if (params.approval) {
      const outcome = await this.resolveApproval({
        approval: params.approval,
        conversationId,
        ctx,
        confirmBeforeSend,
        webSearchEnabled,
      });
      if (outcome) {
        yield* this.completeApprovalTurn({
          conversationId,
          outcome,
          model,
          userId,
          ctx,
          isByok: auth.keySource === 'byok',
        });
        return;
      }
      // Could not be honoured (stale card, replay, failed validation) — fall
      // through to a normal turn so the user still gets a reply.
      this.logger.warn('Approval could not be resolved; running a normal turn');
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

    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort());

    // STATIC stays first (cache-stable prefix). The bridge policy comes LAST so
    // it overrides the web-oriented "buttons/cards" wording for Telegram/WhatsApp.
    const promptParts: string[] = [STATIC_SYSTEM_PROMPT];
    if (confirmBeforeSend) promptParts.push(CONFIRM_BEFORE_SEND_POLICY);
    if (params.sourceChannel) {
      promptParts.push(bridgeChannelPolicy(params.sourceChannel));
    }
    const systemPrompt: string | string[] =
      promptParts.length === 1 ? promptParts[0] : promptParts;

    const input: AgentRunInput = {
      ctx,
      systemPrompt,
      history,
      userMessage: message,
      attachments,
      tools: this.buildTools({ confirmBeforeSend, webSearchEnabled }),
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
      /** Present only on confirm-gate cards — what the card is waiting to do. */
      pendingAction?: PendingAction;
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
                // Persisted so a later approval can re-invoke the exact
                // handler that asked. Absent for ask_user questions.
                ...(isPendingAction(data.pendingAction)
                  ? { pendingAction: data.pendingAction }
                  : {}),
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
      // BYOK turns are LOGGED but not charged — the workspace already paid
      // Anthropic directly with its own key.
      const isByok = auth.keySource === 'byok';
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
        { billable: !isByok },
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
