import { NotFoundException } from '@nestjs/common';
import type { AgentToolDefinition } from '../maestro.types';
import { assembleMaestroTools } from './assemble';
import { TOOL_ACCESS, gateTools } from './capability-gate';
import { runTool } from './run-tool';

const CTX = { userId: 'u1', workspaceId: 'ws1' };

/** Every service stubbed: the factories only close over them. */
function stubDeps() {
  const s = {} as never;
  return {
    users: s,
    workspaces: s,
    unsplash: s,
    pexels: s,
    tavily: s,
    discord: s,
    slack: s,
    inbox: s,
    posts: s,
    channels: s,
    campaigns: s,
    scheduledMessages: s,
    drips: s,
    library: {
      items: s,
      templates: s,
      snippets: s,
      links: s,
      categories: s,
    },
  };
}

function allTools(): AgentToolDefinition[] {
  return assembleMaestroTools(stubDeps(), {
    confirmBeforeSend: true,
    webSearchEnabled: true,
    canNavigate: true,
  });
}

/** An access service that only lets roles holding `allowed` through. */
function fakeAccess(allowed: string[]) {
  return {
    assertCan: jest.fn(async (_ws: string, _u: string, cap: string) => {
      if (!allowed.includes(cap)) throw new NotFoundException('Not found');
      return 'MEMBER' as const;
    }),
  };
}

const VIEWER = ['posts:draft', 'inbox:view', 'analytics:view', 'team:view'];
const MEMBER = [
  ...VIEWER,
  'posts:publish',
  'inbox:reply',
  'channels:manage',
];

function fakeTool(name: string): AgentToolDefinition & {
  handler: jest.Mock;
} {
  return {
    name,
    description: name,
    inputSchema: {},
    handler: jest.fn(async () => ({ ok: true })),
  };
}

describe('every Maestro tool is classified READ or WRITE', () => {
  it('has an entry for every assembled tool, and no stale entries', () => {
    const names = allTools().map((t) => t.name);
    const unclassified = names.filter((n) => !(n in TOOL_ACCESS));
    const stale = Object.keys(TOOL_ACCESS).filter((n) => !names.includes(n));
    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
  });

  // The capability each WRITE group needs, spelled out so a silent downgrade
  // of any entry fails here rather than hiding in the table.
  it.each([
    ['publish_post', 'posts:publish'],
    ['create_template', 'posts:draft'],
    ['create_snippet', 'posts:draft'],
    ['save_link', 'posts:draft'],
    ['send_discord_message', 'inbox:reply'],
    ['send_discord_dm', 'inbox:reply'],
    ['delete_discord_message', 'inbox:reply'],
    ['create_discord_channel', 'channels:manage'],
    ['send_slack_message', 'inbox:reply'],
    ['send_slack_dm', 'inbox:reply'],
    ['delete_slack_message', 'inbox:reply'],
    ['create_slack_channel', 'channels:manage'],
    ['send_telegram_message', 'inbox:reply'],
    ['send_whatsapp_message', 'inbox:reply'],
  ])('%s requires %s', (name, cap) => {
    expect(TOOL_ACCESS[name]).toBe(cap);
  });

  it.each([
    'list_posts',
    'get_post',
    'list_campaigns',
    'get_campaign',
    'list_channels',
    'get_channel_stats',
    'connect_channel',
    'get_inbox_summary',
    'list_conversations',
    'get_conversation',
    'read_discord_messages',
    'read_slack_messages',
    'read_telegram_messages',
    'read_whatsapp_messages',
    'search_library',
    'list_scheduled',
    'search_media',
    'web_search',
    'navigate_to',
    'ask_user',
  ])('%s is READ', (name) => {
    expect(TOOL_ACCESS[name]).toBe('read');
  });
});

describe('gateTools', () => {
  const writes = Object.entries(TOOL_ACCESS).filter(([, c]) => c !== 'read');

  it.each(writes)(
    '%s: a viewer is refused and the handler never runs',
    async (name, cap) => {
      const access = fakeAccess(VIEWER);
      const tool = fakeTool(name);
      const [gated] = gateTools([tool], access);
      if (cap === 'posts:draft') {
        // A viewer may draft, so this one passes for them.
        await expect(gated.handler({}, CTX)).resolves.toEqual({ ok: true });
        return;
      }
      await expect(gated.handler({ a: 1 }, CTX)).rejects.toThrow(
        /does not allow/,
      );
      expect(access.assertCan).toHaveBeenCalledWith('ws1', 'u1', cap);
      expect(tool.handler).not.toHaveBeenCalled();
    },
  );

  it.each(writes)('%s: a member is allowed through', async (name, cap) => {
    const access = fakeAccess(MEMBER);
    const tool = fakeTool(name);
    const [gated] = gateTools([tool], access);
    await expect(gated.handler({ a: 1 }, CTX)).resolves.toEqual({ ok: true });
    expect(access.assertCan).toHaveBeenCalledWith('ws1', 'u1', cap);
    expect(tool.handler).toHaveBeenCalledWith({ a: 1 }, CTX);
  });

  it('a viewer is refused drafting too when they hold no drafting right (non-member)', async () => {
    const access = fakeAccess([]);
    const tool = fakeTool('create_template');
    const [gated] = gateTools([tool], access);
    await expect(gated.handler({}, CTX)).rejects.toThrow(/does not allow/);
    expect(tool.handler).not.toHaveBeenCalled();
  });

  it('READ tools never consult access and keep working for a viewer', async () => {
    const access = fakeAccess([]);
    const tool = fakeTool('list_posts');
    const [gated] = gateTools([tool], access);
    await expect(gated.handler({}, CTX)).resolves.toEqual({ ok: true });
    expect(access.assertCan).not.toHaveBeenCalled();
  });

  it('a tool nobody classified is treated as a publish-level write', async () => {
    const access = fakeAccess(VIEWER);
    const tool = fakeTool('brand_new_tool');
    const [gated] = gateTools([tool], access);
    await expect(gated.handler({}, CTX)).rejects.toThrow(/does not allow/);
    expect(access.assertCan).toHaveBeenCalledWith('ws1', 'u1', 'posts:publish');
  });

  it('keeps the tool definition (name, schema) untouched', () => {
    const tool = fakeTool('publish_post');
    const [gated] = gateTools([tool], fakeAccess(MEMBER));
    expect(gated.name).toBe('publish_post');
    expect(gated.description).toBe(tool.description);
    expect(gated.inputSchema).toBe(tool.inputSchema);
  });

  it('the refusal comes back as a normal tool error result, not a crash', async () => {
    const tool = fakeTool('send_slack_message');
    const [gated] = gateTools([tool], fakeAccess(VIEWER));
    const out = await runTool(gated, {}, CTX);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.text).error).toMatch(/does not allow/);
    expect(tool.handler).not.toHaveBeenCalled();
  });

  it('a genuine handler error is not rewritten into a permission message', async () => {
    const tool = fakeTool('publish_post');
    tool.handler.mockRejectedValue(new Error('channel is disconnected'));
    const [gated] = gateTools([tool], fakeAccess(MEMBER));
    await expect(gated.handler({}, CTX)).rejects.toThrow(
      'channel is disconnected',
    );
  });
});
