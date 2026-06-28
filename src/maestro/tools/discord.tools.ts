import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import type { DiscordService } from '../../channels/services/discord.service';
import type { InboxService } from '../../inbox/inbox.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';

interface Guild {
  /** socialMediaChannels.id — the inbox channelId for this Discord connection. */
  id: number;
  guildId: string;
  guildName: string;
}

/** Cap on images attached to a single send (Discord allows up to 10). */
const MAX_SEND_IMAGES = 4;

/** Keep only valid http(s) URLs, capped. */
function normalizeImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_SEND_IMAGES);
}

/** Best-effort image MIME from a URL extension (default JPEG). */
function guessImageMime(url: string): string {
  const path = url.toLowerCase().split('?')[0];
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/** Download image URLs into Discord upload files. A URL that fails is skipped
 *  (the rest of the message still sends). */
async function downloadImageFiles(
  discord: DiscordService,
  urls: string[],
): Promise<{ name: string; data: Buffer; contentType?: string }[]> {
  const files: { name: string; data: Buffer; contentType?: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const dl = await discord.downloadAttachment(urls[i]);
      const tail = urls[i].split('/').pop()?.split('?')[0] || `image-${i + 1}`;
      files.push({
        name: decodeURIComponent(tail),
        data: dl.buffer,
        contentType: dl.contentType,
      });
    } catch {
      // skip the broken URL; never fail the whole send over one image
    }
  }
  return files;
}

/** Discord servers (guilds) connected to this workspace via the shared bot. */
async function workspaceGuilds(ctx: ToolContext): Promise<Guild[]> {
  const rows = await db
    .select()
    .from(socialMediaChannels)
    .where(
      and(
        eq(socialMediaChannels.platform, 'discord'),
        eq(socialMediaChannels.workspaceId, ctx.workspaceId),
      ),
    );
  return rows
    .filter((r) => !r.connectionStatus || r.connectionStatus === 'connected')
    .map((r) => ({
      id: r.id,
      guildId: r.platformAccountId,
      guildName: r.accountName || 'Discord server',
    }));
}

/** Resolve which guild a request targets. Returns a discriminated result so the
 *  agent can react: no connection, ambiguous (needs a server name), or resolved. */
async function resolveGuild(
  ctx: ToolContext,
  serverName?: string,
): Promise<
  | { ok: true; guild: Guild }
  | { ok: false; reason: 'none' | 'ambiguous' | 'not_found'; guilds: Guild[] }
> {
  const guilds = await workspaceGuilds(ctx);
  if (guilds.length === 0) return { ok: false, reason: 'none', guilds };

  if (serverName) {
    const q = serverName.trim().toLowerCase();
    const match = guilds.find((g) => g.guildName.toLowerCase().includes(q));
    return match
      ? { ok: true, guild: match }
      : { ok: false, reason: 'not_found', guilds };
  }
  if (guilds.length === 1) return { ok: true, guild: guilds[0] };
  return { ok: false, reason: 'ambiguous', guilds };
}

/** Normalize a channel reference ("#general" / "general" / an id) and find it. */
async function resolveChannel(
  discord: DiscordService,
  guildId: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  const channels = await discord.listGuildChannels(guildId);
  const clean = ref.trim().replace(/^#/, '').toLowerCase();
  // Exact id first, then case-insensitive name.
  return (
    channels.find((c) => c.id === ref.trim()) ??
    channels.find((c) => c.name.toLowerCase() === clean) ??
    channels.find((c) => c.name.toLowerCase().includes(clean)) ??
    null
  );
}

/** Friendly payload when no guild could be resolved. */
function guildProblem(
  r: { reason: 'none' | 'ambiguous' | 'not_found'; guilds: Guild[] },
) {
  const names = r.guilds.map((g) => g.guildName);
  if (r.reason === 'none') {
    return {
      kind: 'discord' as const,
      ok: false,
      message:
        'No Discord server is connected to this workspace. Ask the user to connect one in Settings → Channels.',
    };
  }
  return {
    kind: 'discord' as const,
    ok: false,
    message:
      r.reason === 'ambiguous'
        ? `This workspace has multiple Discord servers (${names.join(
            ', ',
          )}). Ask the user which one, then pass it as "server".`
        : `No connected Discord server matches that name. Connected: ${names.join(
            ', ',
          )}.`,
    servers: names,
  };
}

interface DmContact {
  userId: string;
  name: string;
  /** Schedura channel row id + Discord DM channel id — together form the inbox
   *  DM thread key (`<channelId>:<conversationId>`) so replies persist to inbox. */
  channelId: number;
  conversationId: string;
}

/** People who have DM'd the Schedura bot (the only users the bot may DM back).
 *  Sourced from ingested inbox DM rows — Discord forbids cold-DMing strangers. */
async function dmContacts(workspaceId: string): Promise<DmContact[]> {
  const rows = await db
    .select({
      authorPlatformId: inboxItems.authorPlatformId,
      authorDisplayName: inboxItems.authorDisplayName,
      channelId: inboxItems.channelId,
      conversationId: inboxItems.conversationId,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspaceId),
        eq(inboxItems.platform, 'discord'),
        eq(inboxItems.type, 'dm'),
        eq(inboxItems.fromMe, false),
      ),
    )
    .orderBy(desc(inboxItems.platformCreatedAt))
    .limit(300);

  const byId = new Map<string, DmContact>();
  for (const r of rows) {
    if (r.authorPlatformId && r.conversationId && !byId.has(r.authorPlatformId)) {
      byId.set(r.authorPlatformId, {
        userId: r.authorPlatformId,
        name: r.authorDisplayName || 'Unknown',
        channelId: r.channelId,
        conversationId: r.conversationId,
      });
    }
  }
  return [...byId.values()];
}

export function createDiscordTools(
  discord: DiscordService,
  inbox: InboxService,
  opts: { confirmBeforeSend: boolean },
): AgentToolDefinition[] {
  const { confirmBeforeSend } = opts;
  /** Schema field shared by every outward tool that goes through the gate. */
  const confirmedField = z
    .boolean()
    .optional()
    .describe(
      'Leave UNSET on your first call. Only set to true when re-calling this tool after the user approved the confirmation prompt.',
    );
  return [
    {
      name: 'list_discord_channels',
      description:
        "List the text channels of the workspace's connected Discord server(s). Read-only — use it to discover where to post or read before calling the other Discord tools.",
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe('Optional server (guild) name to filter, if several are connected.'),
      },
      handler: async (args, ctx) => {
        const server = args.server ? String(args.server) : undefined;
        const guilds = await workspaceGuilds(ctx);
        if (guilds.length === 0) {
          return guildProblem({ reason: 'none', guilds });
        }
        const targets = server
          ? guilds.filter((g) =>
              g.guildName.toLowerCase().includes(server.toLowerCase()),
            )
          : guilds;
        const servers = await Promise.all(
          targets.map(async (g) => ({
            server: g.guildName,
            channels: (await discord.listGuildChannels(g.guildId)).map((c) => ({
              id: c.id,
              name: c.name,
            })),
          })),
        );
        return { kind: 'discord' as const, ok: true, action: 'channels', servers };
      },
    },

    {
      name: 'read_discord_messages',
      description:
        'Read the most recent messages from a Discord channel (newest first). Read-only.',
      inputSchema: {
        channel: z.string().describe('Channel name (e.g. "general") or channel id.'),
        limit: z
          .number()
          .optional()
          .describe('How many recent messages to fetch (1-50, default 10).'),
        server: z.string().optional().describe('Server name if several are connected.'),
      },
      handler: async (args, ctx) => {
        const r = await resolveGuild(ctx, args.server ? String(args.server) : undefined);
        if (!r.ok) return guildProblem(r);
        const channel = await resolveChannel(
          discord,
          r.guild.guildId,
          String(args.channel || ''),
        );
        if (!channel) {
          return { kind: 'discord' as const, ok: false, message: 'Channel not found in that server.' };
        }
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        const messages = await discord.listChannelMessages(channel.id, limit);
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'messages',
          server: r.guild.guildName,
          channel: channel.name,
          messages,
        };
      },
    },

    {
      name: 'send_discord_message',
      description:
        'Send a message to a Discord channel — text and/or images. Posts publicly to the server — outward-facing. To attach images, pass their URLs in imageUrls (e.g. a search_media result, a web image, or a file the user attached — those URLs are provided to you). The sent message is recorded in the inbox.',
      inputSchema: {
        channel: z.string().describe('Channel name (e.g. "general") or channel id.'),
        message: z.string().optional().describe('The message text to post (optional if sending images).'),
        imageUrls: z
          .array(z.string())
          .optional()
          .describe('Optional image URLs to attach (max 4).'),
        server: z.string().optional().describe('Server name if several are connected.'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        const imageUrls = normalizeImageUrls(args.imageUrls);
        if (!text && imageUrls.length === 0) {
          return {
            kind: 'discord' as const,
            ok: false,
            message: 'Nothing to send — provide a message and/or image URLs.',
          };
        }
        const r = await resolveGuild(ctx, args.server ? String(args.server) : undefined);
        if (!r.ok) return guildProblem(r);
        const channel = await resolveChannel(
          discord,
          r.guild.guildId,
          String(args.channel || ''),
        );
        if (!channel) {
          return { kind: 'discord' as const, ok: false, message: 'Channel not found in that server.' };
        }
        if (!isConfirmed(confirmBeforeSend, args)) {
          const imgPart = imageUrls.length
            ? `${text ? ' + ' : ''}${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`
            : '';
          return confirmCard(
            `Send ${text ? `"${text}"` : ''}${imgPart} to #${channel.name} on ${r.guild.guildName}?`,
            'Yes, send it',
          );
        }
        const files = imageUrls.length
          ? await downloadImageFiles(discord, imageUrls)
          : undefined;
        const sent = await discord.createMessage(channel.id, {
          content: text || undefined,
          files,
        });
        // Mirror the send into the inbox thread for this channel so it appears
        // alongside ingested messages (best-effort — the message already sent).
        try {
          await inbox.recordOutgoingDiscordMessage({
            workspaceId: ctx.workspaceId,
            channelId: r.guild.id,
            conversationId: channel.id,
            platformItemId: sent.id,
            text,
            attachments: imageUrls.map((url) => ({
              kind: 'image' as const,
              url,
              contentType: guessImageMime(url),
            })),
          });
        } catch {
          /* inbox mirroring is non-fatal */
        }
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'sent',
          server: r.guild.guildName,
          channel: channel.name,
          messageId: sent.id,
          ...(imageUrls.length ? { images: imageUrls.length } : {}),
        };
      },
    },

    {
      name: 'send_discord_dm',
      description:
        "Send a direct message (DM) from the Schedura bot to a Discord user — text and/or images (pass image URLs in imageUrls). OUTWARD-FACING. You can ONLY DM people who have already messaged the bot (Discord forbids cold-DMing strangers) — use list_discord_dm_contacts to see who's available. Resolve the recipient by their display name.",
      inputSchema: {
        recipient: z.string().describe("The recipient's display name (e.g. \"Asad\")."),
        message: z.string().optional().describe('The message text to send (optional if sending images).'),
        imageUrls: z
          .array(z.string())
          .optional()
          .describe('Optional image URLs to attach (max 4).'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        const imageUrls = normalizeImageUrls(args.imageUrls);
        if (!text && imageUrls.length === 0) {
          return {
            kind: 'discord' as const,
            ok: false,
            message: 'Nothing to send — provide a message and/or image URLs.',
          };
        }
        const name = String(args.recipient || '').trim().toLowerCase();
        const contacts = await dmContacts(ctx.workspaceId);
        if (contacts.length === 0) {
          return {
            kind: 'discord' as const,
            ok: false,
            message:
              "No one has DM'd the Schedura bot yet, so there's nobody I can DM. The bot can only message users who've contacted it first.",
          };
        }
        const matches = contacts.filter((c) => c.name.toLowerCase().includes(name));
        if (matches.length === 0) {
          return {
            kind: 'discord' as const,
            ok: false,
            message: `I can only DM people who've messaged the Schedura bot. No match for "${args.recipient}". Available: ${contacts
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'discord' as const,
            ok: false,
            message: `Several contacts match "${args.recipient}": ${matches
              .map((c) => c.name)
              .join(', ')}. Ask the user which one.`,
          };
        }
        // Send through the inbox so the DM is persisted + visible in the inbox
        // thread (fromMe), exactly like a manual reply.
        const target = matches[0];
        if (!isConfirmed(confirmBeforeSend, args)) {
          const imgPart = imageUrls.length
            ? `${text ? ' + ' : ''}${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`
            : '';
          return confirmCard(
            `Send ${text ? `"${text}"` : ''}${imgPart} as a DM to ${target.name}?`,
            'Yes, send it',
          );
        }
        const threadKey = `${target.channelId}:${target.conversationId}`;
        const dmAttachments = imageUrls.map((url) => ({
          kind: 'image' as const,
          url,
          contentType: guessImageMime(url),
        }));
        try {
          await inbox.sendDm(
            ctx.workspaceId,
            ctx.userId,
            threadKey,
            text,
            dmAttachments.length ? dmAttachments : undefined,
          );
        } catch (err) {
          return {
            kind: 'discord' as const,
            ok: false,
            message: `Couldn't send the DM to ${target.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'dm_sent',
          recipient: target.name,
        };
      },
    },

    {
      name: 'list_discord_dm_contacts',
      description:
        "List the Discord users the bot can DM (everyone who has messaged the Schedura bot). Read-only — use it before send_discord_dm to pick the right person.",
      inputSchema: {},
      handler: async (_args, ctx) => {
        const contacts = await dmContacts(ctx.workspaceId);
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'dm_contacts',
          contacts: contacts.map((c) => c.name),
        };
      },
    },

    {
      name: 'create_discord_channel',
      description:
        'Create a new text channel in the connected Discord server. Outward-facing — changes the server.',
      inputSchema: {
        name: z.string().describe('Name for the new text channel (lowercase, no spaces).'),
        server: z.string().optional().describe('Server name if several are connected.'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const name = String(args.name || '').trim();
        if (!name) {
          return { kind: 'discord' as const, ok: false, message: 'Channel name is empty.' };
        }
        const r = await resolveGuild(ctx, args.server ? String(args.server) : undefined);
        if (!r.ok) return guildProblem(r);
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Create a new text channel named "${name}" in ${r.guild.guildName}?`,
            'Yes, create it',
          );
        }
        const created = await discord.createGuildChannel(r.guild.guildId, name);
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'created',
          server: r.guild.guildName,
          channel: created.name,
        };
      },
    },

    {
      name: 'delete_discord_message',
      description:
        "Delete a message (that the Schedura bot posted) from a Discord channel. Outward-facing — can't be undone.",
      inputSchema: {
        channel: z.string().describe('Channel name or id where the message is.'),
        messageId: z.string().describe('The id of the message to delete.'),
        server: z.string().optional().describe('Server name if several are connected.'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const r = await resolveGuild(ctx, args.server ? String(args.server) : undefined);
        if (!r.ok) return guildProblem(r);
        const channel = await resolveChannel(
          discord,
          r.guild.guildId,
          String(args.channel || ''),
        );
        if (!channel) {
          return { kind: 'discord' as const, ok: false, message: 'Channel not found in that server.' };
        }
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Delete message ${String(args.messageId || '')} from #${channel.name}? This can't be undone.`,
            'Yes, delete it',
          );
        }
        await discord.deleteMessage(channel.id, String(args.messageId || ''));
        return {
          kind: 'discord' as const,
          ok: true,
          action: 'deleted',
          server: r.guild.guildName,
          channel: channel.name,
        };
      },
    },
  ];
}
