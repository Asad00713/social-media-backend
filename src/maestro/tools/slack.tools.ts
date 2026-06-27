import { z } from 'zod';
import type { SlackService } from '../../channels/services/slack.service';
import type { InboxService } from '../../inbox/inbox.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';

/**
 * Maestro tools for Slack — mirror of the Discord tools. Slack has ONE
 * connection per workspace (the team), and treats channels + DMs uniformly:
 * `conversationId` is any Slack channel/DM id, and `chat.postMessage` works for
 * both. Read/resolve ops call the Slack API directly with the workspace's bot
 * token; SENDS route through `InboxService.sendDm`, which posts AND persists a
 * `fromMe` row — so every channel message and DM appears in the inbox
 * immediately (the same path ingested messages use), with no separate persist
 * step. Attachments (images + files) go through Slack's `files.uploadV2`.
 */

const MAX_SEND_FILES = 5;

/** Connection problem payload (no Slack connected). */
const NO_SLACK = {
  kind: 'slack' as const,
  ok: false,
  message:
    'No Slack workspace is connected. Ask the user to connect Slack in Settings → Channels.',
};

/** Keep only valid http(s) URLs, capped. */
function normalizeFileUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_SEND_FILES);
}

/** Best-effort MIME from a URL extension. */
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

/** Map file URLs to inbox DM attachment inputs. */
function buildAttachments(urls: string[]) {
  return urls.map((url) => {
    const contentType = guessMime(url);
    return { kind: attachmentKind(contentType), url, contentType };
  });
}

interface SlackConn {
  channelId: number;
  accessToken: string;
}

/** Resolve a Slack channel by name ("#general"/"general") or raw id (C…/G…). */
async function resolveSlackChannel(
  slack: SlackService,
  token: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  const raw = ref.trim();
  if (/^[CG][A-Z0-9]+$/.test(raw)) return { id: raw, name: raw.replace(/^#/, '') };
  const clean = raw.replace(/^#/, '').toLowerCase();
  const { channels } = await slack.listAllChannels(token, {
    includePrivate: true,
    limit: 200,
  });
  const match =
    channels.find((c) => c.id === raw) ??
    channels.find((c) => c.name.toLowerCase() === clean) ??
    channels.find((c) => c.name.toLowerCase().includes(clean));
  return match ? { id: match.id, name: match.name } : null;
}

/** Resolve workspace members matching a display name / handle / id. */
async function resolveSlackMembers(
  slack: SlackService,
  token: string,
  ref: string,
): Promise<{ id: string; name: string }[]> {
  const raw = ref.trim();
  if (/^[UW][A-Z0-9]+$/.test(raw)) {
    const u = await slack.getUserInfo(token, raw);
    return u && u.id
      ? [{ id: u.id, name: u.displayName || u.handle || u.id }]
      : [];
  }
  const { members } = await slack.listMembers(token, { query: raw, limit: 200 });
  return members.map((m) => ({ id: m.id, name: m.displayName || m.handle || m.id }));
}

export function createSlackTools(
  slack: SlackService,
  inbox: InboxService,
  opts: { confirmBeforeSend: boolean },
): AgentToolDefinition[] {
  const { confirmBeforeSend } = opts;
  const conn = (ctx: ToolContext): Promise<SlackConn | null> =>
    inbox.resolveWorkspaceChannelToken(ctx.workspaceId, 'slack');
  const confirmedField = z
    .boolean()
    .optional()
    .describe(
      'Leave UNSET on your first call. Only set to true when re-calling this tool after the user approved the confirmation prompt.',
    );
  const fileUrlsField = z
    .array(z.string())
    .optional()
    .describe('Optional image/file URLs to attach (max 5).');

  return [
    {
      name: 'list_slack_channels',
      description:
        "List the Slack workspace's channels (public + private the bot can see). Read-only — use it to find where to post or read.",
      inputSchema: {},
      handler: async (_args, ctx) => {
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const { channels } = await slack.listAllChannels(c.accessToken, {
          includePrivate: true,
          limit: 200,
        });
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'channels',
          channels: channels.map((ch) => ({
            id: ch.id,
            name: ch.name,
            isMember: ch.isMember,
            isPrivate: ch.isPrivate,
          })),
        };
      },
    },

    {
      name: 'read_slack_messages',
      description:
        'Read the most recent messages in a Slack channel (newest first). Read-only.',
      inputSchema: {
        channel: z.string().describe('Channel name (e.g. "general") or channel id.'),
        limit: z.number().optional().describe('How many messages (1-50, default 15).'),
      },
      handler: async (args, ctx) => {
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const ch = await resolveSlackChannel(
          slack,
          c.accessToken,
          String(args.channel || ''),
        );
        if (!ch) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: 'Channel not found. Use list_slack_channels to see options.',
          };
        }
        const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
        const msgs = await slack.getChannelHistory(c.accessToken, ch.id, { limit });
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'messages',
          channel: ch.name,
          messages: msgs.slice(0, limit).map((m) => ({
            ts: (m as { ts?: string }).ts ?? '',
            userId: (m as { user?: string }).user ?? null,
            text: (m as { text?: string }).text ?? '',
          })),
        };
      },
    },

    {
      name: 'list_slack_members',
      description:
        "List Slack workspace members (optionally filtered by a name query). Read-only — use it to find a user's id before DMing them.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional name/handle to filter by (case-insensitive).'),
      },
      handler: async (args, ctx) => {
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const { members } = await slack.listMembers(c.accessToken, {
          query: args.query ? String(args.query) : undefined,
          limit: 200,
        });
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'members',
          members: members.slice(0, 50).map((m) => ({
            id: m.id,
            name: m.displayName || m.handle,
            handle: m.handle,
          })),
        };
      },
    },

    {
      name: 'send_slack_message',
      description:
        'Send a message to a Slack channel — text and/or images/files (pass URLs in fileUrls, e.g. a search_media result, a web image, or a file the user attached). OUTWARD-FACING. The bot auto-joins public channels. The sent message is recorded in the inbox.',
      inputSchema: {
        channel: z.string().describe('Channel name (e.g. "general") or channel id.'),
        message: z.string().optional().describe('Message text (optional if sending files).'),
        fileUrls: fileUrlsField,
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        const fileUrls = normalizeFileUrls(args.fileUrls);
        if (!text && fileUrls.length === 0) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: 'Nothing to send — provide a message and/or file URLs.',
          };
        }
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const ch = await resolveSlackChannel(
          slack,
          c.accessToken,
          String(args.channel || ''),
        );
        if (!ch) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: 'Channel not found. Use list_slack_channels to see options.',
          };
        }
        if (!isConfirmed(confirmBeforeSend, args)) {
          const filePart = fileUrls.length
            ? `${text ? ' + ' : ''}${fileUrls.length} file${fileUrls.length > 1 ? 's' : ''}`
            : '';
          return confirmCard(
            `Send ${text ? `"${text}"` : ''}${filePart} to #${ch.name} on Slack?`,
            'Yes, send it',
          );
        }
        // Bot must be a member to post in a public channel — best-effort join
        // (throws for private/IM or when already in; harmless to ignore).
        try {
          await slack.joinChannel(c.accessToken, ch.id);
        } catch {
          /* private/IM channel or already a member */
        }
        const threadKey = `${c.channelId}:${ch.id}`;
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
            kind: 'slack' as const,
            ok: false,
            message: `Couldn't send to #${ch.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'sent',
          channel: ch.name,
          ...(fileUrls.length ? { files: fileUrls.length } : {}),
        };
      },
    },

    {
      name: 'send_slack_dm',
      description:
        'Send a direct message to a Slack workspace member — text and/or images/files (fileUrls). OUTWARD-FACING. Resolve the recipient by display name; if several match, ask which one. The DM is recorded in the inbox.',
      inputSchema: {
        recipient: z.string().describe("The recipient's display name or Slack user id."),
        message: z.string().optional().describe('Message text (optional if sending files).'),
        fileUrls: fileUrlsField,
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const text = String(args.message || '').trim();
        const fileUrls = normalizeFileUrls(args.fileUrls);
        if (!text && fileUrls.length === 0) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: 'Nothing to send — provide a message and/or file URLs.',
          };
        }
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const matches = await resolveSlackMembers(
          slack,
          c.accessToken,
          String(args.recipient || ''),
        );
        if (matches.length === 0) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: `No workspace member matches "${args.recipient}". Use list_slack_members to find them.`,
          };
        }
        if (matches.length > 1) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: `Several members match "${args.recipient}": ${matches
              .map((m) => m.name)
              .join(', ')}. Ask the user which one.`,
          };
        }
        const target = matches[0];
        if (!isConfirmed(confirmBeforeSend, args)) {
          const filePart = fileUrls.length
            ? `${text ? ' + ' : ''}${fileUrls.length} file${fileUrls.length > 1 ? 's' : ''}`
            : '';
          return confirmCard(
            `Send ${text ? `"${text}"` : ''}${filePart} as a DM to ${target.name} on Slack?`,
            'Yes, send it',
          );
        }
        let dmId: string;
        try {
          dmId = await slack.openDm(c.accessToken, target.id);
        } catch (err) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: `Couldn't open a DM with ${target.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        const threadKey = `${c.channelId}:${dmId}`;
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
            kind: 'slack' as const,
            ok: false,
            message: `Couldn't DM ${target.name}: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'dm_sent',
          recipient: target.name,
          ...(fileUrls.length ? { files: fileUrls.length } : {}),
        };
      },
    },

    {
      name: 'create_slack_channel',
      description:
        'Create a new public Slack channel. Outward-facing — changes the workspace.',
      inputSchema: {
        name: z.string().describe('Name for the new channel (lowercase, hyphens for spaces).'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const name = String(args.name || '').trim();
        if (!name) {
          return { kind: 'slack' as const, ok: false, message: 'Channel name is empty.' };
        }
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Create a new Slack channel named "#${name}"?`,
            'Yes, create it',
          );
        }
        try {
          const created = await slack.createChannel(c.accessToken, { name });
          return {
            kind: 'slack' as const,
            ok: true,
            action: 'created',
            channel: created.name,
          };
        } catch (err) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: `Couldn't create the channel: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
      },
    },

    {
      name: 'delete_slack_message',
      description:
        "Delete a message the bot posted in a Slack channel. Outward-facing — can't be undone.",
      inputSchema: {
        channel: z.string().describe('Channel name or id where the message is.'),
        ts: z.string().describe('The Slack message timestamp (ts) to delete.'),
        confirmed: confirmedField,
      },
      handler: async (args, ctx) => {
        const ts = String(args.ts || '').trim();
        if (!ts) {
          return { kind: 'slack' as const, ok: false, message: 'Message ts is empty.' };
        }
        const c = await conn(ctx);
        if (!c) return NO_SLACK;
        const ch = await resolveSlackChannel(
          slack,
          c.accessToken,
          String(args.channel || ''),
        );
        if (!ch) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: 'Channel not found. Use list_slack_channels to see options.',
          };
        }
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Delete message ${ts} from #${ch.name}? This can't be undone.`,
            'Yes, delete it',
          );
        }
        try {
          await slack.deleteMessage(c.accessToken, ch.id, ts);
        } catch (err) {
          return {
            kind: 'slack' as const,
            ok: false,
            message: `Couldn't delete the message: ${
              err instanceof Error ? err.message : 'unknown error'
            }.`,
          };
        }
        return {
          kind: 'slack' as const,
          ok: true,
          action: 'deleted',
          channel: ch.name,
        };
      },
    },
  ];
}
