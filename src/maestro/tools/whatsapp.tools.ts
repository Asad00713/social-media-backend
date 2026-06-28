import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import type { InboxService } from '../../inbox/inbox.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';

/**
 * Maestro tools for WhatsApp (Meta Cloud API). Like Telegram, WhatsApp is
 * chat-only (no channels) and a business can only message a customer who
 * messaged FIRST — and only within WhatsApp's 24-hour reply window. So chats
 * come from ingested inbox rows (platform='whatsapp', type='dm', fromMe=false),
 * each carrying its connected-number's `channelId`.
 *
 * TEXT ONLY for now — the WhatsApp DM adapter has no `sendDmWithAttachments`, so
 * media is intentionally not exposed here. Sends route through
 * `InboxService.sendDm`, which posts, persists fromMe, AND enforces the 24h
 * window (returns a clear error when it has closed).
 */

interface WaChat {
  name: string;
  /** socialMediaChannels.id of the WhatsApp number this chat belongs to. */
  channelId: number;
  /** Inbox conversationId — `<phoneNumberId>:<waId>`. */
  conversationId: string;
  /** Friendly business-number name (for multi-number disambiguation). */
  account: string;
}

/** Chats the workspace's WhatsApp number(s) can reply to (customers who messaged
 *  first), from ingested inbox rows. Deduped per (number, chat). */
async function whatsappChats(workspaceId: string): Promise<WaChat[]> {
  const numbers = await db
    .select({
      id: socialMediaChannels.id,
      accountName: socialMediaChannels.accountName,
      username: socialMediaChannels.username,
    })
    .from(socialMediaChannels)
    .where(
      and(
        eq(socialMediaChannels.platform, 'whatsapp'),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    );
  if (numbers.length === 0) return [];
  const accountName = new Map(
    numbers.map((n) => [n.id, n.accountName || n.username || 'WhatsApp']),
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
        eq(inboxItems.platform, 'whatsapp'),
        eq(inboxItems.type, 'dm'),
        eq(inboxItems.fromMe, false),
      ),
    )
    .orderBy(desc(inboxItems.platformCreatedAt))
    .limit(300);

  const seen = new Set<string>();
  const out: WaChat[] = [];
  for (const r of rows) {
    if (!r.conversationId) continue;
    const key = `${r.channelId}:${r.conversationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: r.authorDisplayName || 'WhatsApp contact',
      channelId: r.channelId,
      conversationId: r.conversationId,
      account: accountName.get(r.channelId) || 'WhatsApp',
    });
  }
  return out;
}

function matchChats(chats: WaChat[], ref: string): WaChat[] {
  const q = ref.trim().toLowerCase();
  if (!q) return [];
  return chats.filter((c) => c.name.toLowerCase().includes(q));
}

export function createWhatsAppTools(
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
      name: 'list_whatsapp_chats',
      description:
        'List the WhatsApp chats the business can reply to — i.e. customers who have messaged the connected number(s). Read-only.',
      inputSchema: {},
      handler: async (_args, ctx) => {
        const chats = await whatsappChats(ctx.workspaceId);
        return {
          kind: 'whatsapp' as const,
          ok: true,
          action: 'chats',
          chats: chats.map((c) => ({ name: c.name, account: c.account })),
        };
      },
    },

    {
      name: 'read_whatsapp_messages',
      description:
        'Read the most recent messages in a WhatsApp chat (newest first), from the stored inbox history. Read-only.',
      inputSchema: {
        chat: z.string().describe("The contact's name or phone number."),
        limit: z.number().optional().describe('How many messages (1-30, default 15).'),
      },
      handler: async (args, ctx) => {
        const chats = await whatsappChats(ctx.workspaceId);
        if (chats.length === 0) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: 'No WhatsApp conversations yet.',
          };
        }
        const matches = matchChats(chats, String(args.chat || ''));
        if (matches.length === 0) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: `No WhatsApp chat matches "${args.chat}". Available: ${chats
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: `Several chats match "${args.chat}": ${matches
              .map((c) => `${c.name} (${c.account})`)
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
              eq(inboxItems.platform, 'whatsapp'),
              eq(inboxItems.type, 'dm'),
              eq(inboxItems.channelId, target.channelId),
              eq(inboxItems.conversationId, target.conversationId),
            ),
          )
          .orderBy(desc(inboxItems.platformCreatedAt))
          .limit(limit);
        return {
          kind: 'whatsapp' as const,
          ok: true,
          action: 'messages',
          chat: target.name,
          messages: rows.map((r) => ({
            from: r.fromMe ? 'You' : r.authorDisplayName || target.name,
            text: r.text ?? '',
            at: r.platformCreatedAt,
          })),
        };
      },
    },

    {
      name: 'send_whatsapp_message',
      description:
        "Send a WhatsApp text message to a customer who has messaged the business. OUTWARD-FACING. WhatsApp only allows free-form replies within 24 hours of the customer's last message; outside that window the send is rejected (a pre-approved template would be needed). Resolve the recipient by name from list_whatsapp_chats. Text only — no media yet.",
      inputSchema: {
        recipient: z.string().describe("The contact's name or phone number."),
        message: z.string().describe('The message text to send.'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        if (!text) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: 'Message text is empty.',
          };
        }
        const chats = await whatsappChats(ctx.workspaceId);
        if (chats.length === 0) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message:
              "No WhatsApp conversations yet — the business can only message customers who've messaged it first.",
          };
        }
        const matches = matchChats(chats, String(args.recipient || ''));
        if (matches.length === 0) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: `No WhatsApp chat matches "${args.recipient}". Available: ${chats
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: `Several chats match "${args.recipient}": ${matches
              .map((c) => `${c.name} (${c.account})`)
              .join(', ')}. Ask the user which one.`,
          };
        }
        const target = matches[0];
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Send "${text}" to ${target.name} on WhatsApp?`,
            'Yes, send it',
          );
        }
        const threadKey = `${target.channelId}:${target.conversationId}`;
        try {
          await inbox.sendDm(ctx.workspaceId, ctx.userId, threadKey, text);
        } catch (err) {
          // InboxService throws a Forbidden error (with reason) when the 24h
          // window has closed — surface that message verbatim.
          return {
            kind: 'whatsapp' as const,
            ok: false,
            message: `Couldn't message ${target.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'whatsapp' as const,
          ok: true,
          action: 'sent',
          recipient: target.name,
        };
      },
    },
  ];
}
