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
    conversationRows?: Record<string, unknown>[];
    /** Rows per Inbox view; `conversationRows` is shorthand for to_reply. */
    rowsByView?: Record<string, Record<string, unknown>[]>;
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
  const listed =
    (source: string, rows: unknown[]) =>
    (workspaceId: string, query: unknown) => {
      calls.push({ source, workspaceId, arg: query });
      return Promise.resolve(
        guard(source, { items: rows, total: rows.length }),
      );
    };
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
    list: (workspaceId: string, userId: string, q: unknown) => {
      calls.push({ source: 'inbox', workspaceId, arg: { userId, q } });
      return Promise.resolve(
        guard('inbox', {
          rows:
            data.rowsByView?.[(q as { view: string }).view] ??
            ((q as { view: string }).view === 'to_reply'
              ? (data.conversationRows ?? [])
              : []),
          nextCursor: null,
          total: 0,
        }),
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

  it('routes a conversation by its uuid, not the thread key', async () => {
    const service = makeService({
      conversationRows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          threadKey: '2:conv-b',
          platform: 'facebook',
          status: 'to_reply',
          title: 'Omar Hassan',
        },
      ],
    });

    const { results } = await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: '',
    });

    const conv = byType(results, 'conversation')[0];
    // `id` is the conversation uuid — the Inbox opens it with ?c=<id>, never
    // the legacy thread key.
    expect(conv.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(conv.status).toBe('to_reply');
    expect(conv.label).toBe('Omar Hassan');
  });

  it('asks the conversation list for DMs matching the query, in the caller workspace', async () => {
    const calls: Call[] = [];
    const service = makeService({}, calls);
    await service.search({
      workspaceId: WORKSPACE,
      userId: USER,
      query: 'omar',
    });
    const hit = calls.find((c) => c.source === 'inbox');
    expect(hit?.workspaceId).toBe(WORKSPACE);
    expect(hit?.arg).toEqual({
      userId: USER,
      q: expect.objectContaining({ type: 'message', q: 'omar' }) as unknown,
    });
  });

  describe('conversation search', () => {
    const conv = (id: string, title: string, at: string, over = {}) => ({
      id,
      title,
      platform: 'facebook',
      status: 'to_reply',
      lastMessageAt: at,
      snippet: { authorLabel: null, text: '', fromMe: false },
      ...over,
    });
    const search = (service: MentionSearchService, query = '') =>
      service.search({
        workspaceId: WORKSPACE,
        userId: USER,
        query,
        type: 'conversation',
      });

    it('finds DMs parked in Later and finished in Done, not only To reply', async () => {
      const calls: Call[] = [];
      const service = makeService(
        {
          rowsByView: {
            to_reply: [conv('a', 'Ann', '2026-08-01T00:00:00Z')],
            later: [
              conv('b', 'Bea', '2026-08-02T00:00:00Z', { status: 'later' }),
            ],
            done: [conv('c', 'Cy', '2026-08-03T00:00:00Z', { status: 'done' })],
          },
        },
        calls,
      );
      const { results } = await search(service);
      expect(results.map((r) => r.id)).toEqual(['c', 'b', 'a']);
      const views = calls
        .filter((c) => c.source === 'inbox')
        .map((c) => (c.arg as { q: { view: string } }).q.view)
        .sort();
      expect(views).toEqual(['done', 'later', 'to_reply']);
      expect(
        calls
          .filter((c) => c.source === 'inbox')
          .every((c) => c.workspaceId === WORKSPACE),
      ).toBe(true);
    });

    it('returns a conversation once when two views report it', async () => {
      const service = makeService({
        rowsByView: {
          to_reply: [conv('a', 'Ann', '2026-08-01T00:00:00Z')],
          later: [conv('a', 'Ann', '2026-08-01T00:00:00Z')],
        },
      });
      const { results } = await search(service);
      expect(results.map((r) => r.id)).toEqual(['a']);
    });

    it('caps the merged result at the per-type limit, keeping the newest', async () => {
      const service = makeService({
        rowsByView: {
          to_reply: [
            conv('a', 'Ann', '2026-08-01T00:00:00Z'),
            conv('e', 'Eve', '2026-08-05T00:00:00Z'),
          ],
          later: [
            conv('b', 'Bea', '2026-08-02T00:00:00Z'),
            conv('d', 'Dee', '2026-08-04T00:00:00Z'),
          ],
          done: [conv('c', 'Cy', '2026-08-03T00:00:00Z')],
        },
      });
      const { results } = await search(service);
      expect(results.map((r) => r.id)).toEqual(['e', 'd', 'c', 'b']);
    });

    it('filters a 1-character query locally, since the list ignores short q', async () => {
      const calls: Call[] = [];
      const service = makeService(
        {
          conversationRows: [
            conv('a', 'Zed', '2026-08-01T00:00:00Z'),
            conv('b', 'Omar', '2026-08-02T00:00:00Z'),
          ],
        },
        calls,
      );
      const { results } = await search(service, 'o');
      expect(results.map((r) => r.id)).toEqual(['b']);
      for (const c of calls.filter((x) => x.source === 'inbox')) {
        const q = (c.arg as { q: Record<string, unknown> }).q;
        expect(q.q).toBeUndefined();
        expect(q.limit).toBe(50);
      }
    });

    it('also matches a short query on the snippet author label', async () => {
      const service = makeService({
        conversationRows: [
          conv('a', 'Chat 1', '2026-08-01T00:00:00Z', {
            snippet: { authorLabel: 'Quinn', text: '', fromMe: false },
          }),
          conv('b', 'Chat 2', '2026-08-02T00:00:00Z'),
        ],
      });
      const { results } = await search(service, 'q');
      expect(results.map((r) => r.id)).toEqual(['a']);
    });
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
