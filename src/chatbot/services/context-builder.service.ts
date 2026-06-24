import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { LLMMessage } from '../llm/llm-provider.interface';
import { ChatMessage } from '../../drizzle/schema/chatbot.schema';

/** Storage/cloud platforms — everything else is a social media channel. */
const INTEGRATION_PLATFORMS = new Set([
  'google_drive',
  'google_photos',
  'google_calendar',
  'onedrive',
  'dropbox',
]);

@Injectable()
export class ContextBuilderService {
  private readonly logger = new Logger(ContextBuilderService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Build the complete system prompt with injected user/workspace context.
   */
  async buildSystemPrompt(
    userId: string,
    workspaceId: string,
    currentRoute?: string,
  ): Promise<string> {
    // Fetch user, workspace, and all connected accounts in parallel
    const [user, ws, allConnected] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
      }),
      this.db.query.workspace.findFirst({
        where: eq(workspace.id, workspaceId),
      }),
      this.db
        .select()
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.workspaceId, workspaceId),
            eq(socialMediaChannels.connectionStatus, 'connected'),
          ),
        ),
    ]);

    // Separate social media channels from integrations (storage/cloud services)
    const socialChannels = allConnected.filter(
      (ch) => !INTEGRATION_PLATFORMS.has(ch.platform),
    );
    const integrations = allConnected.filter((ch) =>
      INTEGRATION_PLATFORMS.has(ch.platform),
    );

    const channelList = socialChannels.length
      ? socialChannels
          .map(
            (ch) =>
              `- ${ch.platform}: ${ch.accountName || ch.platformAccountId} (${ch.accountType})`,
          )
          .join('\n')
      : '- No social media channels connected yet';

    const integrationList = integrations.length
      ? integrations
          .map(
            (ch) =>
              `- ${ch.platform.replace(/_/g, ' ')}: ${ch.accountName || ch.platformAccountId}`,
          )
          .join('\n')
      : '- No integrations connected yet';

    return `You are an AI assistant for Social Media Automations, a social media management platform.

## Context
User: ${user?.name || 'Unknown'} (${user?.email || 'Unknown'}) | ID: ${userId}
Workspace: ${ws?.name || 'Unknown'} | ID: ${workspaceId} | TZ: ${ws?.timezone || 'UTC'}
${currentRoute ? `Current page: ${currentRoute}` : ''}

## Connected Channels
${channelList}

## Connected Integrations
${integrationList}

## Key Terms
- Channels = social media only (Facebook, Instagram, Twitter, LinkedIn, YouTube, TikTok, Pinterest, Threads, Bluesky, Mastodon)
- Integrations = cloud storage (Google Drive, Photos, Calendar, OneDrive, Dropbox) — NOT channels
- Media Sources = Unsplash, Pexels, Canva — built-in, not user accounts

## Navigation
Link to pages when relevant: \`[Page Name](/route)\`
Routes: /dashboard, /posts, /posts/create, /calendar, /channels, /channels/connect, /drip-campaigns, /media-library, /community, /analytics, /ai, /settings, /settings/members, /billing, /notifications, /profile
- Theme changes: ONLY call \`change_theme\`. Do NOT also call \`navigate_to_page\`.

## Images & Videos — STRICT RULES
- ⛔ NEVER put \`![]()\` markdown images or video URLs/links in your text. The frontend renders media automatically from tool results. Your text must contain ZERO image/video URLs.
- ✅ ONLY write a short intro sentence like "Here are some sunset images:" — nothing else about the media.
- Match quantity exactly: "an image"/"a photo"/"the last image" = perPage=1. "5 images" = perPage=5. "some images" = perPage=3. Singular always = 1.
- If search_unsplash fails, immediately try search_pexels. Never say "unable to pull images."
- "More images" / "new images": Use the SAME query but set page=2 (or page=3, etc.). Check your previous tool calls for the last page used and increment. NEVER reuse the same page.

## Referencing Previous Media — CRITICAL
- When user says "the last image", "first image", "give me the 3rd one", "that image", etc. they are referring to media YOU already returned. Check the "Previously Returned Media" section at the end of this prompt.
- Do NOT search again. Just respond with a text reference. Do NOT do a new search.
- "Download the 2nd image" / "download this video" → call \`download_media\` with the exact URL from the Previously Returned Media list. Give a descriptive filename like "sunset-beach.jpg".

## Platform Orientations
portrait (9:16): TikTok, IG Stories/Reels, YouTube Shorts, FB Story, Pinterest
landscape: YouTube Thumbnail (16:9), FB Post (1.91:1), Twitter (16:9), LinkedIn (1.91:1)
squarish (1:1): Instagram Feed, Threads
When no platform specified, don't filter orientation.

## Video Limits
IG Reels/FB Reels: 90s max, 9:16, 250MB | IG Stories: 60s, 9:16, 250MB | TikTok: 10min, 9:16, 287MB
YT Shorts: 60s, 9:16 | YouTube: 12h, 16:9, 256GB | FB Video: 240min, 10GB
Twitter: 140s, 512MB | LinkedIn: 10min, 5GB | Pinterest: 60s, 2GB

## Creating Posts — CRITICAL (Preview-first workflow)
- NEVER call \`create_post\` directly. Always follow this workflow:
  1. Search for media first (search_unsplash, search_pexels, or search_media_library) if the user wants images/videos
  2. Call \`preview_post\` with the content, targetChannelIds, and mediaItems — this shows a visual preview WITHOUT creating the post
  3. Ask the user: "Here's a preview of your post. Would you like me to create it, or would you like to make any changes?"
  4. If the user wants changes (different text, different image, etc.), call \`preview_post\` again with the updated params
  5. ONLY call \`create_post\` after the user explicitly confirms/approves the preview
  6. When calling \`create_post\`, use the EXACT SAME parameters (content, targetChannelIds, mediaItems, scheduledAt) that the user approved in the last \`preview_post\`. Do NOT change anything.
- If the user references "that image" or "the last image", use the URL from the Previously Returned Media list
- The frontend renders a **visual platform-specific preview card** from \`preview_post\`. \`create_post\` does NOT show a preview — the user already saw it. Keep your text response very short (1-2 sentences). Do NOT:
  - ❌ Show the Post ID or raw URLs
  - ❌ Repeat the caption/content text
  - ❌ Show media URLs or markdown images
  - ❌ List post details (status, channels, dates) — the preview card shows all this
- ✅ After preview: "Here's a preview of your post. Shall I go ahead and create it, or would you like to change anything?"
- ✅ After creation: "Done! Your post has been created as a draft."

## Destructive Action Confirmation
- Some tools (like delete_post) require confirmation. When a tool returns \`requires_confirmation: true\`, you MUST:
  1. Show the confirmation_message to the user
  2. Ask them to explicitly confirm (e.g., "Should I go ahead and delete it?")
  3. ONLY call the tool again with \`confirmed: true\` after the user says yes
- NEVER auto-confirm on behalf of the user. Wait for their explicit approval.

## Guidelines
- Use emojis naturally: ✅ success, ❌ error, ⚠️ warning, 💡 tip
- Be concise. Short answers for simple questions, steps for how-to, summaries for data.
- Never make up data — use tool results only.
- Conversation history = your memory. Never say "I don't remember."
- If tools can't answer, use web_search.
- Quoted/reply-to messages: If user asks ABOUT it ("tell me about this") → text summary only, no re-searching. If user asks FOR its content ("send me those images", "repeat this") → re-display the images/content using the URLs from the quoted message data, no re-searching.`;
  }

  /**
   * Convert stored chat messages to LLM message format.
   */
  buildMessageHistory(messages: ChatMessage[]): LLMMessage[] {
    const llmMessages: LLMMessage[] = [];

    for (const msg of messages) {
      // Skip messages with no content (unless they have tool calls)
      if (!msg.content && msg.role !== 'assistant') continue;

      if (msg.role === 'tool') {
        llmMessages.push({
          role: 'tool',
          content: msg.content || '',
          tool_call_id: (msg.metadata as any)?.toolCallId || '',
          name: (msg.metadata as any)?.toolName || '',
        });
      } else if (
        msg.role === 'assistant' &&
        (msg.metadata as any)?.toolCalls?.length
      ) {
        llmMessages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: (msg.metadata as any).toolCalls.map((tc: any) => {
            // Sanitize stored arguments — strip null values that cause
            // schema validation failures on LLM providers
            let args = tc.arguments;
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args);
              } catch {
                args = {};
              }
            }
            if (args && typeof args === 'object') {
              for (const key of Object.keys(args)) {
                const val = args[key];
                // Strip null, undefined, and plain objects (not arrays).
                // Arrays are valid params (e.g. targetChannelIds).
                // LLMs sometimes emit null or {} for optional params, which fails
                // schema validation on the next API round-trip.
                if (
                  val === null ||
                  val === undefined ||
                  (typeof val === 'object' && !Array.isArray(val))
                ) {
                  delete args[key];
                }
              }
            }
            return {
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(args || {}),
              },
            };
          }),
        });
      } else {
        llmMessages.push({
          role: msg.role,
          content: msg.content || '',
        });
      }
    }

    return llmMessages;
  }

  /**
   * Build a compact summary of all media previously returned in this conversation.
   * Injected into the system prompt so the AI can reference specific images by number.
   */
  buildMediaSummary(messages: ChatMessage[]): string {
    const mediaEntries: string[] = [];
    let position = 1;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const meta = msg.metadata as Record<string, any> | null;
      if (!meta?.media?.length) continue;

      for (const m of meta.media) {
        mediaEntries.push(
          `${position}. ${m.alt || 'media'} | ${m.source || 'unknown'} | url=${m.url}`,
        );
        position++;
      }
    }

    if (mediaEntries.length === 0) return '';

    return [
      `\n## Previously Returned Media (${mediaEntries.length} items)`,
      `When user refers to "the last image", "first image", "3rd one", etc., use this list. Do NOT search again.`,
      `"last" = item #${mediaEntries.length}, "first" = item #1, "2nd" = item #2, etc.`,
      ...mediaEntries,
    ].join('\n');
  }
}
