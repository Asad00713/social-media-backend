import { z } from 'zod';
import type { ChannelService } from '../../channels/services/channel.service';
import {
  CHANNEL_CATEGORY,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import type { AgentToolDefinition } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';

/** Platforms a user can connect. Mirrors the OAuth initiate surface. */
const CONNECTABLE_PLATFORMS = [
  'facebook',
  'instagram',
  'twitter',
  'linkedin',
  'youtube',
  'tiktok',
  'pinterest',
  'threads',
  'bluesky',
  'mastodon',
  'reddit',
] as const;

/**
 * What the user actually needs to know about a channel's health, derived from
 * connection status and token expiry. The raw DTO carries a dozen token fields;
 * an agent answer needs one short phrase.
 */
function channelHealth(ch: {
  connectionStatus: string;
  isActive: boolean;
  isTokenExpired?: boolean;
  refreshTokenExpiresInDays?: number | null;
}): string {
  if (ch.connectionStatus === 'expired' || ch.isTokenExpired) {
    return 'needs reconnect';
  }
  if (ch.connectionStatus === 'revoked') return 'access revoked';
  if (ch.connectionStatus === 'error') return 'error';
  if (!ch.isActive) return 'inactive';

  const days = ch.refreshTokenExpiresInDays;
  if (typeof days === 'number' && days <= 7) {
    return days <= 0 ? 'needs reconnect' : `expires in ${days}d`;
  }
  return 'connected';
}

/**
 * True for a publishing channel (social or messaging), false for a cloud
 * storage or calendar integration.
 *
 * Derived from the PLATFORM, not from the row's stored `category` column: that
 * column defaults to 'social' and was only backfilled where the migration ran,
 * so a row can mislabel itself. Asking "which channels do I have" must not
 * answer with Google Drive.
 */
function isPublishingChannel(platform: string): boolean {
  const category = CHANNEL_CATEGORY[platform as SupportedPlatform];
  // An unknown platform is more likely a new social network than a new cloud
  // drive, and hiding a real channel is worse than showing one extra.
  return category === undefined || category !== 'integration';
}

/** The label a channel is known by, falling back through what we actually have. */
function channelLabel(ch: {
  accountName?: string | null;
  username?: string | null;
  platform: string;
}): string {
  return ch.accountName || ch.username || ch.platform;
}

/**
 * Read-only tools over the workspace's connected channels, plus the interactive
 * card that starts a connection.
 *
 * Every read derives its workspace from `ctx` — never from tool arguments. A
 * workspace id accepted as an argument would let the model read across tenants
 * if it ever hallucinated one, so the boundary is enforced by shape, not by
 * instruction.
 */
export function createChannelTools(
  channels: ChannelService,
): AgentToolDefinition[] {
  return [
    {
      name: 'list_channels',
      description:
        'List the social media channels connected to this workspace, with each one\'s health (connected, needs reconnect, expiring soon, error). Use this for "what channels do I have", "is anything disconnected", or before suggesting where to post.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        platform: z
          .string()
          .optional()
          .describe(
            'Optional platform filter, e.g. "instagram". Omit to list every channel.',
          ),
      },
      handler: async (args, ctx) => {
        const platform =
          typeof args.platform === 'string' && args.platform.trim()
            ? args.platform.trim().toLowerCase()
            : undefined;

        const list = await channels.getWorkspaceChannels(ctx.workspaceId, {
          ...(platform ? { platform } : {}),
        } as never);

        const items = list
          .filter((ch) => isPublishingChannel(ch.platform))
          .map((ch) => ({
            id: String(ch.id),
            platform: ch.platform,
            name: channelLabel(ch),
            username: ch.username ?? null,
            health: channelHealth(ch),
            lastPostedAt: ch.lastPostedAt ?? null,
          }));

        const refs: EntityReference[] = items.map((it) => ({
          kind: 'channel',
          id: it.id,
          label: it.name,
          status: it.health,
        }));

        return withReferences(
          {
            total: items.length,
            channels: items,
            needsAttention: items
              .filter((it) => it.health !== 'connected')
              .map((it) => it.name),
          },
          refs,
        );
      },
    },

    {
      name: 'get_channel_stats',
      description:
        'Get a summary of this workspace\'s channel connections: how many in total, how many healthy, how many expired or erroring, and the split per platform. Use this for "how are my channels doing" or "is everything connected".',
      inputSchema: {},
      handler: async (_args, ctx) => {
        // Derived from the channel list rather than getChannelStats(), whose
        // totals include cloud-storage and calendar integrations. Those are not
        // publishing channels, and counting them would answer "how are my
        // channels doing" with Google Drive in the total.
        const list = (
          await channels.getWorkspaceChannels(ctx.workspaceId)
        ).filter((ch) => isPublishingChannel(ch.platform));

        const byPlatform: Record<string, number> = {};
        for (const ch of list) {
          byPlatform[ch.platform] = (byPlatform[ch.platform] || 0) + 1;
        }

        const health = list.map((ch) => channelHealth(ch));
        return {
          total: list.length,
          healthy: health.filter((h) => h === 'connected').length,
          needsReconnect: health.filter((h) => h === 'needs reconnect').length,
          erroring: health.filter(
            (h) => h === 'error' || h === 'access revoked',
          ).length,
          byPlatform,
        };
      },
    },

    {
      name: 'connect_channel',
      description:
        'Offer the user a button that starts connecting a social media account. Use this when the user wants to connect, add, or reconnect a channel — do NOT explain the steps in prose, and do NOT send them a URL. If you do not know which platform they mean, ask first with ask_user, then call this. Returns a card the user clicks; the connection happens in their browser, so nothing is connected until they do.',
      inputSchema: {
        platform: z
          .enum(CONNECTABLE_PLATFORMS)
          .describe('The platform to connect, e.g. "instagram".'),
      },
      handler: async (args, ctx) => {
        // Zod validates this, but a tool handler is also reachable from the
        // approval path with stored args — coerce defensively rather than
        // stringifying whatever arrived.
        const platform =
          typeof args.platform === 'string'
            ? args.platform.trim().toLowerCase()
            : '';

        if (!(CONNECTABLE_PLATFORMS as readonly string[]).includes(platform)) {
          return {
            error: `"${platform}" is not a platform this workspace can connect.`,
            supported: CONNECTABLE_PLATFORMS,
          };
        }

        // Already connected and healthy? Say so rather than offering a button
        // that would start a redundant OAuth round trip. Integrations are
        // excluded so a stray cloud-storage row cannot mask a real channel.
        const existing = await channels.getWorkspaceChannels(ctx.workspaceId, {
          platform,
        } as never);
        const publishing = existing.filter((ch) =>
          isPublishingChannel(ch.platform),
        );
        const healthy = publishing.filter(
          (ch) => channelHealth(ch) === 'connected',
        );

        if (healthy.length > 0) {
          return withReferences(
            {
              kind: 'connect',
              platform,
              alreadyConnected: true,
              accounts: healthy.map((ch) => channelLabel(ch)),
            },
            healthy.map((ch) => ({
              kind: 'channel' as const,
              id: String(ch.id),
              label: channelLabel(ch),
              status: 'connected',
            })),
          );
        }

        return {
          kind: 'connect',
          platform,
          alreadyConnected: false,
          // Present when the user is re-authorising a broken channel rather
          // than adding a new one — the UI words the button differently.
          reconnect: publishing.length > 0,
        };
      },
    },
  ];
}
