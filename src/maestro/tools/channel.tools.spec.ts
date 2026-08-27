import type { ChannelService } from '../../channels/services/channel.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createChannelTools } from './channel.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

/** A channel as `getWorkspaceChannels` returns it — only the fields we read. */
function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    platform: 'instagram',
    accountName: 'Schedura',
    username: 'schedura',
    isActive: true,
    connectionStatus: 'connected',
    isTokenExpired: false,
    refreshTokenExpiresInDays: null,
    lastPostedAt: null,
    ...over,
  };
}

interface Recorded {
  workspaceId: string;
  query: unknown;
}

function fakeService(rows: unknown[], calls: Recorded[] = []) {
  return {
    getWorkspaceChannels: (workspaceId: string, query?: unknown) => {
      calls.push({ workspaceId, query });
      const platform = (query as { platform?: string } | undefined)?.platform;
      const filtered = platform
        ? rows.filter((r) => (r as { platform: string }).platform === platform)
        : rows;
      return Promise.resolve(filtered);
    },
    getChannelStats: () =>
      Promise.resolve({
        totalChannels: 4,
        activeChannels: 3,
        expiredChannels: 1,
        errorChannels: 0,
        byPlatform: { instagram: 2, facebook: 2 },
      }),
  } as unknown as ChannelService;
}

function tool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

describe('channel tools', () => {
  describe('list_channels', () => {
    it('returns each channel with a reference so the name can be linked', async () => {
      const tools = createChannelTools(fakeService([channelRow()]));

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs).toEqual([
        { kind: 'channel', id: '1', label: 'Schedura', status: 'connected' },
      ]);
    });

    // A reference whose id does not match the entity produces a link to the
    // wrong place — worse than no link. Pin the correspondence explicitly.
    it('gives every listed channel a reference with its own id', async () => {
      const tools = createChannelTools(
        fakeService([
          channelRow({ id: 7, accountName: 'A' }),
          channelRow({ id: 9, accountName: 'B' }),
        ]),
      );

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const data = result.data as { channels: { id: string; name: string }[] };

      expect(result.refs.map((r) => [r.id, r.label])).toEqual([
        ['7', 'A'],
        ['9', 'B'],
      ]);
      expect(data.channels.map((c) => c.id)).toEqual(['7', '9']);
    });

    // The workspace is a tenant boundary: it must come from the request
    // context, never from something the model can put in an argument.
    it('scopes the read to the caller workspace, ignoring any argument', async () => {
      const calls: Recorded[] = [];
      const tools = createChannelTools(fakeService([channelRow()], calls));

      await tool(tools, 'list_channels').handler(
        { workspaceId: 'ws-someone-else' },
        CTX,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].workspaceId).toBe('ws-1');
    });

    it('passes a platform filter through when asked for one', async () => {
      const calls: Recorded[] = [];
      const tools = createChannelTools(
        fakeService(
          [channelRow(), channelRow({ id: 2, platform: 'facebook' })],
          calls,
        ),
      );

      const result = (await tool(tools, 'list_channels').handler(
        { platform: 'Facebook' },
        CTX,
      )) as ReferencePayload;

      expect(calls[0].query).toEqual({ platform: 'facebook' });
      expect(result.refs).toHaveLength(1);
    });

    it('reports an empty workspace as empty, not as an error', async () => {
      const tools = createChannelTools(fakeService([]));

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const data = result.data as { total: number };

      expect(data.total).toBe(0);
      expect(result.refs).toEqual([]);
    });

    it.each([
      [
        'an expired connection',
        { connectionStatus: 'expired' },
        'needs reconnect',
      ],
      ['an expired token', { isTokenExpired: true }, 'needs reconnect'],
      ['a revoked channel', { connectionStatus: 'revoked' }, 'access revoked'],
      ['an erroring channel', { connectionStatus: 'error' }, 'error'],
      ['a deactivated channel', { isActive: false }, 'inactive'],
      [
        'a token expiring soon',
        { refreshTokenExpiresInDays: 3 },
        'expires in 3d',
      ],
      ['a healthy channel', {}, 'connected'],
    ])('describes %s as "%s"', async (_name, over, expected) => {
      const tools = createChannelTools(fakeService([channelRow(over)]));

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(result.refs[0].status).toBe(expected);
    });

    it('surfaces the channels needing attention so the agent can lead with them', async () => {
      const tools = createChannelTools(
        fakeService([
          channelRow({ id: 1, accountName: 'Healthy' }),
          channelRow({
            id: 2,
            accountName: 'Broken',
            connectionStatus: 'expired',
          }),
        ]),
      );

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const data = result.data as { needsAttention: string[] };

      expect(data.needsAttention).toEqual(['Broken']);
    });

    it('falls back to the username, then the platform, for an unnamed channel', async () => {
      const tools = createChannelTools(
        fakeService([
          channelRow({ id: 1, accountName: null }),
          channelRow({ id: 2, accountName: null, username: null }),
        ]),
      );

      const result = (await tool(tools, 'list_channels').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(result.refs.map((r) => r.label)).toEqual([
        'schedura',
        'instagram',
      ]);
    });
  });

  describe('get_channel_stats', () => {
    it('summarises connection health for the workspace', async () => {
      const tools = createChannelTools(fakeService([]));

      const result = (await tool(tools, 'get_channel_stats').handler(
        {},
        CTX,
      )) as Record<string, unknown>;

      expect(result).toEqual({
        total: 4,
        healthy: 3,
        expired: 1,
        erroring: 0,
        byPlatform: { instagram: 2, facebook: 2 },
      });
    });
  });

  describe('connect_channel', () => {
    it('offers a connect card for a platform with no channel yet', async () => {
      const tools = createChannelTools(fakeService([]));

      const result = (await tool(tools, 'connect_channel').handler(
        { platform: 'tiktok' },
        CTX,
      )) as Record<string, unknown>;

      expect(result).toEqual({
        kind: 'connect',
        platform: 'tiktok',
        alreadyConnected: false,
        reconnect: false,
      });
    });

    // Offering a button for something already working sends the user through a
    // redundant OAuth round trip and reads as if the agent cannot see state.
    it('says it is already connected instead of offering a button', async () => {
      const tools = createChannelTools(fakeService([channelRow()]));

      const result = (await tool(tools, 'connect_channel').handler(
        { platform: 'instagram' },
        CTX,
      )) as ReferencePayload;
      const data = result.data as {
        alreadyConnected: boolean;
        accounts: string[];
      };

      expect(data.alreadyConnected).toBe(true);
      expect(data.accounts).toEqual(['Schedura']);
      expect(result.refs[0].id).toBe('1');
    });

    it('offers to reconnect when the existing channel is broken', async () => {
      const tools = createChannelTools(
        fakeService([channelRow({ connectionStatus: 'expired' })]),
      );

      const result = (await tool(tools, 'connect_channel').handler(
        { platform: 'instagram' },
        CTX,
      )) as Record<string, unknown>;

      expect(result.alreadyConnected).toBe(false);
      expect(result.reconnect).toBe(true);
    });

    it('refuses a platform this workspace cannot connect', async () => {
      const tools = createChannelTools(fakeService([]));

      const result = (await tool(tools, 'connect_channel').handler(
        { platform: 'myspace' },
        CTX,
      )) as Record<string, unknown>;

      expect(result.error).toContain('myspace');
      expect(result.kind).toBeUndefined();
    });
  });
});
