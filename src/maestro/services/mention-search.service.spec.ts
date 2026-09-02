import {
  MentionSearchService,
  MENTION_TYPES,
  type MentionResult,
} from './mention-search.service';

const WORKSPACE = 'ws-1';
const USER = 'u-1';

/** What each source was asked for, so scoping and filtering can be asserted. */
interface Call {
  source: string;
  workspaceId: string;
  arg?: unknown;
}

function makeService(
  data: {
    posts?: Record<string, unknown>[];
    campaigns?: { id: string; name: string; type: string; status: string }[];
    channels?: Record<string, unknown>[];
    templates?: { id: string; name: string; templateType?: string }[];
    snippets?: { id: string; name: string; snippetType?: string }[];
    media?: { id: string; name: string; type?: string }[];
    members?: {
      owner: { id: string; name: string | null; email: string } | null;
      members: unknown[];
    };
    dms?: Record<string, unknown>[];
    failing?: string[];
  } = {},
  calls: Call[] = [],
) {
  const fails = new Set(data.failing ?? []);
  const guard = <T>(source: string, value: T): T => {
    if (fails.has(source)) throw new Error(`${source} is down`);
    return value;
  };

  const posts = {
    getWorkspacePosts: (workspaceId: string, arg: unknown) => {
      calls.push({ source: 'posts', workspaceId, arg });
      return Promise.resolve(
        guard('posts', { posts: data.posts ?? [], total: 0 }),
      );
    },
  };
  const campaigns = {
    list: (workspaceId: string) => {
      calls.push({ source: 'campaigns', workspaceId });
      return Promise.resolve(guard('campaigns', data.campaigns ?? []));
    },
  };
  const channels = {
    getWorkspaceChannels: (workspaceId: string) => {
      calls.push({ source: 'channels', workspaceId });
      return Promise.resolve(guard('channels', data.channels ?? []));
    },
  };
  const listed = (source: string, rows: unknown[]) => (
    (workspaceId: string, query: unknown) => {
      calls.push({ source, workspaceId, arg: query });
      return Promise.resolve(guard(source, { items: rows, total: rows.length }));
    }
  );
  const templates = { findAll: listed('templates', data.templates ?? []) };
  const snippets = { findAll: listed('snippets', data.snippets ?? []) };
  const mediaItems = { findAll: listed('media', data.media ?? []) };
  const members = {
    getMembers: (workspaceId: string, userId: string) => {
      calls.push({ source: 'members', workspaceId, arg: userId });
      return Promise.resolve(
        guard(
          'members',
          data.members ?? { owner: null, members: [], totalMembers: 0 },
        ),
      );
    },
  };
  const inbox = {
    listDmConversations: (workspaceId: string, userId: string) => {
      calls.push({ source: 'inbox', workspaceId, arg: userId });
      return Promise.resolve(
        guard('inbox', { threads: data.dms ?? [], nextCursor: null }),
      );
    },
  };

  return new MentionSearchService(
    posts as never,
    channels as never,
    campaigns as never,
    inbox as never,
    members as never,
    mediaItems as never,
    templates as never,
    snippets as never,
  );
}

const byType = (results: MentionResult[], type: string) =>
  results.filter((r) => r.type === type);

describe('MentionSearchService', () => {
  it('opens with something in it, before the user types anything', async () => {
    const service = makeService({
      posts: [{ id: 'p1', content: { text: 'Summer sale' }, status: 'draft' }],
      campaigns: [
        { id: 'c1', name: 'Autumn Launch', type: 'bulk', status: 'active' },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    // An empty picker that says "type to search" makes the user guess what is
    // mentionable at all. ClickUp's opens populated; so does this.
    expect(results.length).toBeGreaterThan(0);
  });

  it('searches every type at once when no tab is chosen', async () => {
    const calls: Call[] = [];
    const service = makeService({}, calls);

    await service.search({ workspaceId: WORKSPACE, userId: USER, query: '' });

    // One source per mentionable type — a type with no source silently
    // disappears from the picker, which is invisible until a user looks for it.
    expect(new Set(calls.map((c) => c.source)).size).toBe(MENTION_TYPES.length);
  });

  it('asks only the chosen type when a tab is selected', async () => {
    const calls: Call[] = [];
    const service = makeService({}, calls);

    await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
      type: 'campaign',
    });

    expect(calls.map((c) => c.source)).toEqual(['campaigns']);
  });

  it('scopes every source to the caller workspace', async () => {
    const calls: Call[] = [];
    const service = makeService({}, calls);

    await service.search({ workspaceId: WORKSPACE, userId: USER, query: '' });

    expect(calls.every((c) => c.workspaceId === WORKSPACE)).toBe(true);
  });

  it('still returns the other types when one source is down', async () => {
    const service = makeService({
      campaigns: [
        { id: 'c1', name: 'Autumn Launch', type: 'bulk', status: 'active' },
      ],
      failing: ['posts', 'inbox'],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    // A picker that renders nothing because ONE source failed is worse than one
    // missing a section: the user cannot tell which happened.
    expect(byType(results, 'campaign')).toHaveLength(1);
    expect(byType(results, 'post')).toHaveLength(0);
  });

  it('filters on what the user actually sees, not the raw row', async () => {
    const service = makeService({
      posts: [
        { id: 'p1', content: { text: 'Summer sale is live' }, status: 'draft' },
        { id: 'p2', content: { text: 'Winter preview' }, status: 'draft' },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: 'summer',
    });

    expect(byType(results, 'post').map((r) => r.label)).toEqual([
      'Summer sale is live',
    ]);
  });

  it('names a post by its first line, which is how people recognise it', async () => {
    const service = makeService({
      posts: [
        {
          id: 'p1',
          content: { text: 'Launch day!\nSecond line nobody scans for' },
          status: 'scheduled',
        },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    expect(byType(results, 'post')[0].label).toBe('Launch day!');
  });

  it('includes the owner, who is otherwise the one person you cannot mention', async () => {
    const service = makeService({
      members: {
        owner: { id: 'o1', name: 'Asad', email: 'a@example.com' },
        members: [
          {
            role: 'MEMBER',
            user: { id: 'm1', name: 'Sara', email: 's@example.com' },
          },
        ],
      },
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    // The owner lives outside the members array in the roster response, so
    // forgetting them is the easy bug — and the most visible one.
    expect(byType(results, 'member').map((r) => r.label)).toEqual([
      'Asad',
      'Sara',
    ]);
  });

  it('carries a dead channel state, so it is never mentioned silently', async () => {
    const service = makeService({
      channels: [
        {
          id: 7,
          accountName: 'Brand IG',
          username: 'brand',
          platform: 'instagram',
          isActive: false,
        },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    const channel = byType(results, 'channel')[0];
    expect(channel.status).toBe('needs reconnect');
    expect(channel.platform).toBe('instagram');
  });

  it('routes a conversation by its thread key, not the platform id', async () => {
    const service = makeService({
      dms: [
        {
          id: '2:conv-b',
          conversationId: 'conv-b',
          platform: 'facebook',
          status: 'needs_reply',
          participant: { displayName: 'Omar Hassan', handle: 'omar.h' },
        },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    const conv = byType(results, 'conversation')[0];
    // `conversationId` is the platform's own id and opens nothing; `id` is what
    // the Inbox routes on.
    expect(conv.id).toBe('2:conv-b');
    expect(conv.label).toBe('Omar Hassan');
  });

  it('returns nothing rather than everything when nothing matches', async () => {
    const service = makeService({
      campaigns: [
        { id: 'c1', name: 'Autumn Launch', type: 'bulk', status: 'active' },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: 'nothing-matches-this',
    });

    expect(results).toEqual([]);
  });
});
