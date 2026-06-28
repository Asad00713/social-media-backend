import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import type { InboxService } from '../../inbox/inbox.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';

/**
 * Maestro tools for Telegram. Telegram bots are per-workspace CUSTOM bots (a
 * workspace can connect several), and — like Discord DMs — a bot can only
 * message people who have already started a chat with it. So there is no
 * "list channels"/cold-DM surface: the chats a bot can message come straight
 * from ingested inbox rows (platform='telegram', type='dm', fromMe=false). Each
 * chat carries its bot's `channelId`, so multi-bot "which bot to send from" is
 * resolved automatically — you reply on the same bot the person messaged.
 *
 * Reads come from our stored inbox rows (the Bot API exposes no history). Sends
 * route through `InboxService.sendDm` (posts + persists fromMe + handles media).
 */

const MAX_SEND_FILES = 5;

function normalizeFileUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_SEND_FILES);
}

function guessMime(url: string): string {
  const path = url.toLowerCase().split('?')[0];
  if (/\.(jpe?g)$/.test(path)) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return 'application/octet-stream';
}

function attachmentKind(mime: string): 'image' | 'video' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function buildAttachments(urls: string[]) {
  return urls.map((url) => {
    const contentType = guessMime(url);
    return { kind: attachmentKind(contentType), url, contentType };
  });
}

interface TgChat {
  name: string;
  /** socialMediaChannels.id of the bot this chat belongs to. */
  channelId: number;
  /** Telegram chat id. */
  conversationId: string;
  /** Friendly bot name (for multi-bot disambiguation). */
  bot: string;
}

/** Chats the workspace's Telegram bot(s) can message — i.e. people who have
 *  messaged a bot, sourced from ingested inbox rows. Deduped per (bot, chat). */
async function telegramChats(workspaceId: string): Promise<TgChat[]> {
  const bots = await db
    .select({
      id: socialMediaChannels.id,
      accountName: socialMediaChannels.accountName,
      username: socialMediaChannels.username,
    })
    .from(socialMediaChannels)
    .where(
      and(
        eq(socialMediaChannels.platform, 'telegram'),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    );
  if (bots.length === 0) return [];
  const botName = new Map(
    bots.map((b) => [b.id, b.accountName || b.username || 'Telegram bot']),
  );

  const rows = await db
    .select({
      authorDisplayName: inboxItems.authorDisplayName,
      channelId: inboxItems.channelId,
      conversationId: inboxItems.conversationId,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspaceId),
        eq(inboxItems.platform, 'telegram'),
        eq(inboxItems.type, 'dm'),
        eq(inboxItems.fromMe, false),
      ),
    )
    .orderBy(desc(inboxItems.platformCreatedAt))
    .limit(300);

  const seen = new Set<string>();
  const out: TgChat[] = [];
  for (const r of rows) {
    if (!r.conversationId) continue;
    const key = `${r.channelId}:${r.conversationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: r.authorDisplayName || 'Telegram user',
      channelId: r.channelId,
      conversationId: r.conversationId,
      bot: botName.get(r.channelId) || 'Telegram bot',
    });
  }
  return out;
}

/** Match chats by name (case-insensitive substring). */
function matchChats(chats: TgChat[], ref: string): TgChat[] {
  const q = ref.trim().toLowerCase();
  if (!q) return [];
  return chats.filter((c) => c.name.toLowerCase().includes(q));
}

export function createTelegramTools(
  inbox: InboxService,
  opts: { confirmBeforeSend: boolean },
): AgentToolDefinition[] {
  const { confirmBeforeSend } = opts;
  const confirmedField = z
    .boolean()
    .optional()
    .describe(
      'Leave UNSET on your first call. Only set to true when re-calling this tool after the user approved the confirmation prompt.',
    );

  return [
    {
      name: 'list_telegram_chats',
      description:
        'List the Telegram chats the bot(s) can message — i.e. people who have messaged a connected bot. Read-only. (A bot can only message people who started a chat with it.)',
      inputSchema: {},
      handler: async (_args, ctx) => {
        const chats = await telegramChats(ctx.workspaceId);
        return {
          kind: 'telegram' as const,
          ok: true,
          action: 'chats',
          chats: chats.map((c) => ({ name: c.name, bot: c.bot })),
        };
      },
    },

    {
      name: 'read_telegram_messages',
      description:
        'Read the most recent messages in a Telegram chat (newest first), from the stored inbox history. Read-only.',
      inputSchema: {
        chat: z.string().describe("The chat/person's name."),
        limit: z.number().optional().describe('How many messages (1-30, default 15).'),
      },
      handler: async (args, ctx) => {
        const chats = await telegramChats(ctx.workspaceId);
        if (chats.length === 0) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: 'No one has messaged your Telegram bot yet.',
          };
        }
        const matches = matchChats(chats, String(args.chat || ''));
        if (matches.length === 0) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: `No Telegram chat matches "${args.chat}". Available: ${chats
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: `Several chats match "${args.chat}": ${matches
              .map((c) => `${c.name} (via ${c.bot})`)
              .join(', ')}. Ask the user which one.`,
          };
        }
        const target = matches[0];
        const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 30);
        const rows = await db
          .select({
            authorDisplayName: inboxItems.authorDisplayName,
            text: inboxItems.text,
            fromMe: inboxItems.fromMe,
            platformCreatedAt: inboxItems.platformCreatedAt,
          })
          .from(inboxItems)
          .where(
            and(
              eq(inboxItems.workspaceId, ctx.workspaceId),
              eq(inboxItems.platform, 'telegram'),
              eq(inboxItems.type, 'dm'),
              eq(inboxItems.channelId, target.channelId),
              eq(inboxItems.conversationId, target.conversationId),
            ),
          )
          .orderBy(desc(inboxItems.platformCreatedAt))
          .limit(limit);
        return {
          kind: 'telegram' as const,
          ok: true,
          action: 'messages',
          chat: target.name,
          messages: rows.map((r) => ({
            from: r.fromMe ? 'You (bot)' : r.authorDisplayName || target.name,
            text: r.text ?? '',
            at: r.platformCreatedAt,
          })),
        };
      },
    },

    {
      name: 'send_telegram_message',
      description:
        'Send a Telegram message to a chat — text and/or images/files (pass URLs in fileUrls). OUTWARD-FACING. You can only message people who have already messaged a connected bot (use list_telegram_chats). Resolve the recipient by name. The message is recorded in the inbox.',
      inputSchema: {
        recipient: z.string().describe("The chat/person's name to message."),
        message: z.string().optional().describe('Message text (optional if sending files).'),
        fileUrls: z
          .array(z.string())
          .optional()
          .describe('Optional image/file URLs to attach (max 5).'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        const fileUrls = normalizeFileUrls(args.fileUrls);
        if (!text && fileUrls.length === 0) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: 'Nothing to send — provide a message and/or file URLs.',
          };
        }
        const chats = await telegramChats(ctx.workspaceId);
        if (chats.length === 0) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message:
              "No one has messaged your Telegram bot yet, so there's no chat to send to. A bot can only message people who started a chat with it.",
          };
        }
        const matches = matchChats(chats, String(args.recipient || ''));
        if (matches.length === 0) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: `No Telegram chat matches "${args.recipient}". Available: ${chats
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: `Several chats match "${args.recipient}": ${matches
              .map((c) => `${c.name} (via ${c.bot})`)
              .join(', ')}. Ask the user which one.`,
          };
        }
        const target = matches[0];
        if (!isConfirmed(confirmBeforeSend, args)) {
          const filePart = fileUrls.length
            ? `${text ? ' + ' : ''}${fileUrls.length} file${fileUrls.length > 1 ? 's' : ''}`
            : '';
          return confirmCard(
            `Send ${text ? `"${text}"` : ''}${filePart} to ${target.name} on Telegram (via ${target.bot})?`,
            'Yes, send it',
          );
        }
        const threadKey = `${target.channelId}:${target.conversationId}`;
        const attachments = buildAttachments(fileUrls);
        try {
          await inbox.sendDm(
            ctx.workspaceId,
            ctx.userId,
            threadKey,
            text,
            attachments.length ? attachments : undefined,
          );
        } catch (err) {
          return {
            kind: 'telegram' as const,
            ok: false,
            message: `Couldn't message ${target.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'telegram' as const,
          ok: true,
          action: 'sent',
          recipient: target.name,
          bot: target.bot,
          ...(fileUrls.length ? { files: fileUrls.length } : {}),
        };
      },
    },
  ];
}
