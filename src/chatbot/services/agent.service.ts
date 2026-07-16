import { Injectable, Logger } from '@nestjs/common';
import { LLMRouterService } from '../llm/llm-router.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { GroqChatProvider } from '../llm/groq.provider';
import {
  LLMMessage,
  LLMToolCall,
  LLMUsage,
} from '../llm/llm-provider.interface';
import { ToolContext } from '../tools/tool.interface';

/**
 * SSE event types emitted by the agent loop.
 */
export interface MediaItem {
  id: string;
  url: string;
  thumbnailUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  photographer?: string;
  source: string;
  mimeType?: string;
  duration?: number;
}

export interface PostPreviewData {
  postId: string;
  content: string;
  status: string;
  scheduledAt?: string;
  platform: string;
  channelName: string;
  channelAvatar?: string;
  channelUsername?: string;
  mediaItems: Array<{
    url: string;
    type: string;
    thumbnailUrl?: string;
    altText?: string;
  }>;
  hashtags?: string[];
}

export type AgentSSEEvent =
  | { event: 'thinking_start'; data: Record<string, never> }
  | { event: 'thinking_step'; data: { step: string } }
  | { event: 'tool_executing'; data: { tool: string } }
  | { event: 'tool_complete'; data: { tool: string } }
  | { event: 'message_stream'; data: { token: string } }
  | { event: 'message_complete'; data: { content: string } }
  | { event: 'message_saved'; data: { messageId: string } }
  | { event: 'title_generated'; data: { title: string } }
  | { event: 'followups'; data: { suggestions: string[] } }
  | {
      event: 'actions';
      data: { actions: Array<{ type: string; payload: Record<string, any> }> };
    }
  | { event: 'media'; data: { items: MediaItem[] } }
  | { event: 'post_preview'; data: { previews: PostPreviewData[] } }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: Record<string, never> };

export interface AgentResult {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
  thinkingSteps: string[];
  followups: string[];
  actions: Array<{ type: string; payload: Record<string, any> }>;
  totalTokens: number;
  modelUsed: string;
}

const MAX_ITERATIONS = 10;

/** Fallback model when the primary hits rate limits. */
const FALLBACK_MODEL = 'llama-3.3-70b-versatile';

/**
 * Trim conversation history to keep token counts manageable.
 * Keeps the system message + the most recent `keep` user/assistant turns.
 */
function trimHistory(messages: LLMMessage[], keep = 10): LLMMessage[] {
  // Always keep the first message (system prompt)
  if (messages.length <= keep + 1) return messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  return [...system, ...messages.slice(-keep)];
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly llmRouter: LLMRouterService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /**
   * Run the agent loop.
   *
   * This is the core engine:
   * 1. Send messages to LLM with available tools
   * 2. If LLM returns tool calls → execute them, add results, loop
   * 3. If LLM returns text → stream it token by token
   * 4. Generate follow-up suggestions
   * 5. Yield done
   */
  async *run(
    messages: LLMMessage[],
    context: ToolContext,
    signal?: AbortSignal,
    options?: { preferredProvider?: string },
  ): AsyncGenerator<AgentSSEEvent> {
    const provider = this.llmRouter.getProvider({
      preferredProvider: options?.preferredProvider,
    });
    const toolDefs = this.toolRegistry.getToolDefinitions();

    // Classify intent from last user message to optimize model selection
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    const intent = lastUserMsg?.content
      ? this.llmRouter.classifyIntent(lastUserMsg.content)
      : 'tool_calling';

    let model = this.llmRouter.getModelForProvider(provider.name, intent);
    const useTools = intent !== 'simple'; // Skip tools for simple queries

    const thinkingSteps: string[] = [];
    const allToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, any>;
    }> = [];
    let finalContent = '';
    let totalTokens = 0;
    let keyRotationsUsed = 0; // prevent infinite key rotation loop
    const returnedMediaIds = new Set<string>(); // track returned media to prevent duplicates

    // Trim long conversation history to stay within token budgets
    messages = trimHistory(messages, 12);

    yield { event: 'thinking_start', data: {} };

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal?.aborted) {
        yield { event: 'error', data: { message: 'Request cancelled' } };
        return;
      }

      let streamedContent = '';
      let toolCalls: LLMToolCall[] = [];
      let usage: LLMUsage | undefined;

      try {
        for await (const chunk of provider.chatStream(messages, {
          model,
          tools: useTools && toolDefs.length > 0 ? toolDefs : undefined,
          temperature: 0.7,
          maxTokens: intent === 'simple' ? 1024 : 4096,
        })) {
          if (signal?.aborted) {
            yield { event: 'error', data: { message: 'Request cancelled' } };
            return;
          }

          if (chunk.type === 'content') {
            streamedContent += chunk.content;
            yield { event: 'message_stream', data: { token: chunk.content } };
          }

          if (chunk.type === 'tool_calls') {
            toolCalls = chunk.toolCalls;
          }

          if (chunk.type === 'done') {
            usage = chunk.usage;
            if (usage) totalTokens += usage.totalTokens;
          }
        }
      } catch (error) {
        const isGroq = provider instanceof GroqChatProvider;

        // Rate limit / request too large → try rotating API key first, then fall back to smaller model
        if (isGroq && provider.isRateLimitError(error)) {
          // Step 1: Try the next API key (same model) — only if we haven't already rotated all keys
          if (keyRotationsUsed < 1 && provider.rotateKey()) {
            keyRotationsUsed++;
            this.logger.warn(
              `Rate limit hit on ${model} — rotating to next API key`,
            );
            yield {
              event: 'thinking_step',
              data: { step: 'Retrying...' },
            };
            iteration--;
            continue;
          }

          // Step 2: All keys exhausted — fall back to smaller model
          if (model !== FALLBACK_MODEL) {
            keyRotationsUsed = 0; // reset for the fallback model
            this.logger.warn(
              `All API keys rate-limited on ${model} — falling back to ${FALLBACK_MODEL}`,
            );
            model = FALLBACK_MODEL;
            yield {
              event: 'thinking_step',
              data: { step: 'Switching to faster model...' },
            };
            messages = trimHistory(messages, 6);
            iteration--;
            continue;
          }
        }

        // If Groq failed to generate a valid tool call, retry without tools
        const isToolError = isGroq && provider.isToolCallError(error);

        if (isToolError && toolDefs.length > 0) {
          this.logger.warn(
            'Tool call generation failed — retrying without tools',
          );
          yield {
            event: 'thinking_step',
            data: { step: 'Adjusting approach...' },
          };

          // Strip tool-related messages from history so the LLM doesn't
          // try to generate tool calls again. Keep only system/user/assistant(text) messages.
          const cleanMessages = messages
            .filter((m) => m.role !== 'tool')
            .map((m) => {
              if (m.role === 'assistant' && m.tool_calls) {
                // Keep the assistant text but remove tool_calls
                return {
                  role: m.role,
                  content: m.content || 'I was working on your request.',
                };
              }
              return m;
            });

          // CRITICAL: Tell the LLM not to claim actions it didn't perform.
          // The tool call failed, so no action was taken. The LLM must NOT
          // lie to the user by saying "I've saved/created/updated" anything.
          cleanMessages.push({
            role: 'user',
            content:
              '[SYSTEM: Your previous tool call failed due to a technical error. ' +
              'No action was actually performed. Do NOT claim you created, saved, ' +
              'scheduled, or completed any action. Instead, apologize for the ' +
              'technical issue and ask the user to try again.]',
          });

          try {
            for await (const chunk of provider.chatStream(cleanMessages, {
              model,
              temperature: 0.7,
              maxTokens: 4096,
              // No tools — force a plain text response
            })) {
              if (signal?.aborted) {
                yield {
                  event: 'error',
                  data: { message: 'Request cancelled' },
                };
                return;
              }
              if (chunk.type === 'content') {
                streamedContent += chunk.content;
                yield {
                  event: 'message_stream',
                  data: { token: chunk.content },
                };
              }
              if (chunk.type === 'done') {
                usage = chunk.usage;
                if (usage) totalTokens += usage.totalTokens;
              }
            }
          } catch (retryError) {
            this.logger.error(`LLM retry also failed: ${retryError}`);
            yield {
              event: 'error',
              data: {
                message: `AI processing failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`,
              },
            };
            return;
          }

          // Fall through to the text response handling below
        } else {
          this.logger.error(`LLM streaming error: ${error}`);
          yield {
            event: 'error',
            data: {
              message: `AI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          };
          return;
        }
      }

      // If we got tool calls, execute them and loop
      if (toolCalls.length > 0) {
        // Add assistant message with tool calls to conversation
        messages.push({
          role: 'assistant',
          content: streamedContent || null,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const step = this.toolRegistry.getToolDisplayName(toolName);
          thinkingSteps.push(step);

          yield { event: 'thinking_step', data: { step } };
          yield { event: 'tool_executing', data: { tool: toolName } };

          let parsedArgs: Record<string, any>;
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
            parsedArgs = this.sanitizeToolArgs(parsedArgs);
          } catch {
            parsedArgs = {};
          }

          // Update the tool call arguments so the sanitized version
          // is stored in conversation history sent back to the LLM
          toolCall.function.arguments = JSON.stringify(parsedArgs);

          allToolCalls.push({
            id: toolCall.id,
            name: toolName,
            arguments: parsedArgs,
          });

          const result = await this.toolRegistry.execute(
            toolName,
            parsedArgs,
            context,
          );

          yield { event: 'tool_complete', data: { tool: toolName } };

          // Emit structured media data for frontend rendering (filter out duplicates)
          const rawMediaItems = this.extractMediaItems(toolName, result);
          const mediaItems = rawMediaItems.filter(
            (m) => !returnedMediaIds.has(m.id),
          );
          for (const m of mediaItems) returnedMediaIds.add(m.id);
          if (mediaItems.length > 0) {
            yield { event: 'media', data: { items: mediaItems } };
          }

          // Emit post preview data for create_post results
          const postPreviews = this.extractPostPreviews(toolName, result);
          if (postPreviews.length > 0) {
            yield { event: 'post_preview', data: { previews: postPreviews } };
          }

          // Emit UI actions from tool results (navigation, etc.)
          const toolActions = this.extractToolActions(toolName, result);

          // Add save-to-library actions for media items (skip if already from Media Library)
          const mediaActions = this.extractMediaActions(mediaItems);
          const allActions = [...toolActions, ...mediaActions];

          if (allActions.length > 0) {
            yield { event: 'actions', data: { actions: allActions } };
          }

          // Add tool result to messages
          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: toolCall.id,
            name: toolName,
          });
        }

        // Continue the loop — LLM will process tool results
        continue;
      }

      // No tool calls — this is the final text response
      if (streamedContent) {
        finalContent = streamedContent;
        messages.push({ role: 'assistant', content: finalContent });
      }

      break;
    }

    // Clean up text response — media is rendered separately by frontend
    if (finalContent) {
      // Extract any markdown images the AI put in text and convert to media events
      const mdImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
      let match: RegExpExecArray | null;
      const inlineMedia: MediaItem[] = [];
      while ((match = mdImageRegex.exec(finalContent)) !== null) {
        const url = match[2];
        // Avoid re-emitting images already sent via tool results
        if (!returnedMediaIds.has(url)) {
          inlineMedia.push({
            id: url,
            url,
            alt: match[1] || 'image',
            source: 'referenced',
          });
          returnedMediaIds.add(url);
        }
      }
      if (inlineMedia.length > 0) {
        yield { event: 'media', data: { items: inlineMedia } };
      }

      // Strip all markdown images from text
      finalContent = finalContent.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

      // If any media was involved this turn, keep ONLY the first line (intro sentence).
      if (returnedMediaIds.size > 0) {
        const firstLine = finalContent
          .split('\n')
          .find((l) => l.trim().length > 0);
        finalContent = firstLine?.trim() || finalContent.trim();
      } else {
        finalContent = finalContent.replace(/\n{3,}/g, '\n\n').trim();
      }
    }

    // Emit message complete
    if (finalContent) {
      yield { event: 'message_complete', data: { content: finalContent } };
    }

    // Generate follow-up suggestions
    const followups = await this.generateFollowups(messages);
    if (followups.length > 0) {
      yield { event: 'followups', data: { suggestions: followups } };
    }

    yield { event: 'done', data: {} };
  }

  /**
   * Generate follow-up suggestions using a fast model call.
   * Always returns 2-3 contextual, action-oriented suggestions.
   */
  private async generateFollowups(messages: LLMMessage[]): Promise<string[]> {
    try {
      const provider = this.llmRouter.getProvider();

      // Only send the last few messages for context (saves tokens)
      const recentMessages = messages.slice(-6);

      const response = await provider.chat(
        [
          {
            role: 'system',
            content: `You generate follow-up action buttons for a social media management AI assistant.

Rules:
- ALWAYS return exactly 3 suggestions
- Keep each suggestion short (3-8 words)
- Make them action-oriented (start with a verb)
- Make them contextually relevant to what was just discussed
- They should feel like natural next steps the user would want to take
- Cover different actions (don't repeat similar suggestions)

Available actions in this platform: create posts, schedule posts, list posts, view channels, check analytics, view scheduled posts, search the web, navigate to pages, manage workspace, view profile.

Return ONLY a JSON array of 3 strings. No explanation, no markdown.
Example: ["Create a new post", "View my scheduled posts", "Check my analytics"]`,
          },
          ...recentMessages,
          {
            role: 'user',
            content:
              'Generate 3 follow-up suggestions based on the conversation above.',
          },
        ],
        {
          model: this.llmRouter.getModelForTask('simple'),
          temperature: 0.6,
          maxTokens: 128,
        },
      );

      if (response.content) {
        const match = response.content.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.slice(0, 3);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to generate follow-ups: ${error}`);
    }

    // Fallback — always return something useful
    return [
      'What can you help me with?',
      'Show my connected channels',
      'Create a new post',
    ];
  }

  /**
   * Sanitize tool call arguments to fix common LLM mistakes.
   *
   * This runs BEFORE tool execution and also cleans the arguments that get
   * stored in conversation history (sent back to the LLM on the next turn).
   *
   * Fixes:
   * - null / undefined values → removed (would fail schema validation)
   * - Plain empty objects {} for optional params → removed
   * - mediaItems as strings → converted to {url, type} objects
   * - targetChannelIds as numbers → converted to strings
   */
  private sanitizeToolArgs(args: Record<string, any>): Record<string, any> {
    for (const key of Object.keys(args)) {
      const val = args[key];

      // Strip null / undefined
      if (val === null || val === undefined) {
        delete args[key];
        continue;
      }

      // Strip empty plain objects (not arrays, not Date, etc.)
      if (
        typeof val === 'object' &&
        !Array.isArray(val) &&
        !(val instanceof Date) &&
        Object.keys(val).length === 0
      ) {
        delete args[key];
        continue;
      }

      // Normalize mediaItems — LLMs sometimes pass strings instead of objects
      if (key === 'mediaItems' && Array.isArray(val)) {
        args[key] = val
          .map((item: any) => {
            if (typeof item === 'string') {
              return { url: item, type: 'image' };
            }
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              return { ...item, type: item.type || 'image' };
            }
            return item;
          })
          .filter(Boolean);
        continue;
      }

      // Normalize targetChannelIds — ensure all items are strings
      if (key === 'targetChannelIds' && Array.isArray(val)) {
        args[key] = val.map((id: any) => String(id));
        continue;
      }
    }

    return args;
  }

  /**
   * Check whether a value looks like a usable HTTPS image/video URL.
   */
  private isValidMediaUrl(url: unknown): url is string {
    return typeof url === 'string' && url.startsWith('https://');
  }

  /**
   * Extract structured media items from tool results for frontend rendering.
   * Returns an array of MediaItem objects that the frontend can display as a gallery.
   * Filters out items with broken/missing URLs.
   */
  private extractMediaItems(toolName: string, result: any): MediaItem[] {
    if (!result?.success || !result?.data) return [];

    const items: MediaItem[] = [];

    // Unsplash results
    if (toolName === 'search_unsplash' && result.data.images) {
      for (const img of result.data.images) {
        const url = img.urls?.regular || img.urls?.small;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: img.id,
          url,
          thumbnailUrl: img.urls?.small || img.urls?.thumb || url,
          alt: img.description || 'Unsplash photo',
          width: img.width,
          height: img.height,
          photographer: img.photographer,
          source: 'Unsplash',
        });
      }
    }

    // Pexels photo results
    if (toolName === 'search_pexels' && result.data.images) {
      for (const img of result.data.images) {
        const url = img.src?.large || img.src?.medium;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: String(img.id),
          url,
          thumbnailUrl: img.src?.medium || img.src?.small || url,
          alt: img.alt || 'Pexels photo',
          width: img.width,
          height: img.height,
          photographer: img.photographer,
          source: 'Pexels',
        });
      }
    }

    // Pexels video results
    if (toolName === 'search_pexels' && result.data.videos) {
      for (const vid of result.data.videos) {
        const url = vid.videoFiles?.[0]?.link || vid.url;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: String(vid.id),
          url,
          thumbnailUrl: this.isValidMediaUrl(vid.image) ? vid.image : undefined,
          alt: 'Pexels video',
          width: vid.width,
          height: vid.height,
          photographer: vid.photographer,
          source: 'Pexels',
          duration: vid.duration,
          mimeType: 'video/mp4',
        });
      }
    }

    // OneDrive results
    if (toolName === 'search_onedrive' && result.data.files) {
      for (const f of result.data.files) {
        const url = f.downloadUrl || f.webUrl;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: f.id,
          url,
          thumbnailUrl: this.isValidMediaUrl(f.thumbnails?.small?.url)
            ? f.thumbnails.small.url
            : undefined,
          alt: f.name,
          width: f.image?.width,
          height: f.image?.height,
          source: 'OneDrive',
          mimeType: f.mimeType,
        });
      }
    }

    // Dropbox results
    if (toolName === 'search_dropbox' && result.data.files) {
      for (const f of result.data.files) {
        const url = f.downloadUrl;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: f.id,
          url,
          alt: f.name,
          source: 'Dropbox',
          mimeType: f.mediaInfo?.['.tag'] === 'video' ? 'video/mp4' : undefined,
          width: f.mediaInfo?.dimensions?.width,
          height: f.mediaInfo?.dimensions?.height,
          duration: f.mediaInfo?.duration,
        });
      }
    }

    // Google Photos results
    if (toolName === 'search_google_photos' && result.data.items) {
      for (const item of result.data.items) {
        if (!this.isValidMediaUrl(item.baseUrl)) continue;
        items.push({
          id: item.id,
          url: item.baseUrl,
          thumbnailUrl: `${item.baseUrl}=w400-h300`,
          alt: item.filename,
          width: Number(item.width) || undefined,
          height: Number(item.height) || undefined,
          source: 'Google Photos',
          mimeType: item.mimeType,
        });
      }
    }

    // Web search image results (Tavily)
    if (toolName === 'web_search' && result.data.images) {
      for (const img of result.data.images) {
        if (!this.isValidMediaUrl(img.url)) continue;
        items.push({
          id: img.url,
          url: img.url,
          alt: img.description || 'Web image',
          source: 'Web',
        });
      }
    }

    // Media Library results
    if (toolName === 'search_media_library' && result.data.items) {
      for (const item of result.data.items) {
        if (!this.isValidMediaUrl(item.fileUrl)) continue;
        items.push({
          id: item.id,
          url: item.fileUrl,
          thumbnailUrl: this.isValidMediaUrl(item.thumbnailUrl)
            ? item.thumbnailUrl
            : item.fileUrl,
          alt: item.name || item.description,
          width: item.width,
          height: item.height,
          source: 'Media Library',
          mimeType: item.mimeType,
          duration: item.duration,
        });
      }
    }

    return items;
  }

  /**
   * Extract UI actions from tool results.
   * Tools like navigate_to_page and change_theme return action payloads.
   */
  private extractToolActions(
    toolName: string,
    result: any,
  ): Array<{ type: string; payload: Record<string, any> }> {
    if (!result?.success || !result?.data) return [];

    // navigate_to_page → { action: 'navigate', route }
    if (toolName === 'navigate_to_page' && result.data.action === 'navigate') {
      return [
        {
          type: 'navigate',
          payload: { route: result.data.route },
        },
      ];
    }

    // change_theme → { action: 'change_theme', theme }
    if (toolName === 'change_theme' && result.data.action === 'change_theme') {
      return [
        {
          type: 'change_theme',
          payload: { theme: result.data.theme },
        },
      ];
    }

    // download_media → { action: 'download', url, filename }
    if (toolName === 'download_media' && result.data.action === 'download') {
      return [
        {
          type: 'download',
          payload: {
            url: result.data.url,
            filename: result.data.filename,
          },
        },
      ];
    }

    return [];
  }

  /**
   * Extract post preview data from preview_post tool results.
   * Builds one preview per target platform with channel details and media.
   * Only triggers for preview_post — create_post does not emit previews
   * since the user already reviewed the preview before confirming.
   */
  private extractPostPreviews(
    toolName: string,
    result: any,
  ): PostPreviewData[] {
    if (toolName !== 'preview_post' || !result?.success || !result?.data)
      return [];

    const { id, content, status, scheduledAt, targets, mediaItems, metadata } =
      result.data;
    if (!targets || !Array.isArray(targets)) return [];

    // Extract hashtags from content
    const hashtags = (content || '').match(/#\w+/g) || [];

    return targets.map((t: any) => ({
      postId: id,
      content: t.contentOverride?.text || content || '',
      status: status || 'draft',
      scheduledAt: scheduledAt || undefined,
      platform: t.platform,
      channelName: t.channelName || t.platform,
      channelAvatar: t.channelAvatar || undefined,
      channelUsername: t.channelUsername || undefined,
      mediaItems: (mediaItems || []).map((m: any) => ({
        url: m.url,
        type: m.type || 'image',
        thumbnailUrl: m.thumbnailUrl,
        altText: m.altText,
      })),
      hashtags: hashtags.length > 0 ? hashtags : undefined,
    }));
  }

  /**
   * Generate save-to-library actions for media items from external sources.
   * Skips items that are already from the Media Library.
   */
  private extractMediaActions(
    mediaItems: MediaItem[],
  ): Array<{ type: string; payload: Record<string, any> }> {
    // Only generate actions for external media (not already in user's library)
    const externalItems = mediaItems.filter(
      (m) => m.source !== 'Media Library',
    );
    if (externalItems.length === 0) return [];

    const actions: Array<{ type: string; payload: Record<string, any> }> = [];

    // Individual save action per media item
    for (const item of externalItems) {
      actions.push({
        type: 'save_to_library',
        payload: {
          url: item.url,
          thumbnailUrl: item.thumbnailUrl,
          name: item.alt || `${item.source} media`,
          mediaType: item.mimeType?.startsWith('video') ? 'video' : 'image',
          width: item.width,
          height: item.height,
          source: item.source,
          mimeType: item.mimeType,
          duration: item.duration,
        },
      });
    }

    // Bulk save action when there are multiple items
    if (externalItems.length > 1) {
      actions.push({
        type: 'save_all_to_library',
        payload: {
          items: externalItems.map((item) => ({
            url: item.url,
            thumbnailUrl: item.thumbnailUrl,
            name: item.alt || `${item.source} media`,
            mediaType: item.mimeType?.startsWith('video') ? 'video' : 'image',
            width: item.width,
            height: item.height,
            source: item.source,
            mimeType: item.mimeType,
            duration: item.duration,
          })),
        },
      });
    }

    return actions;
  }
}
