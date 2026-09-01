import type { PostService } from '../../posts/services/post.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createPostTools } from './post.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

/** A post row as the service returns it — only the fields the tools read. */
function postRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    workspaceId: 'ws-1',
    status: 'draft',
    content: 'Autumn collection drops Friday',
    mediaItems: [],
    targets: [{ channelId: '1', platform: 'instagram', status: 'draft' }],
    platformContent: {},
    scheduledAt: null,
    publishedAt: null,
    ...over,
  };
}

interface Recorded {
  workspaceId: string;
  options?: unknown;
  postId?: string;
}

function fakeService(rows: Record<string, unknown>[], calls: Recorded[] = []) {
  return {
    getWorkspacePosts: (workspaceId: string, options?: unknown) => {
      calls.push({ workspaceId, options });
      const status = (options as { status?: string } | undefined)?.status;
      const mine = rows.filter((r) => r.workspaceId === workspaceId);
      const filtered = status ? mine.filter((r) => r.status === status) : mine;
      return Promise.resolve({ posts: filtered, total: filtered.length });
    },
    getPost: (postId: string, workspaceId: string) => {
      calls.push({ workspaceId, postId });
      const found = rows.find(
        (r) => r.id === postId && r.workspaceId === workspaceId,
      );
      if (!found) return Promise.reject(new Error('Post not found'));
      return Promise.resolve(found);
    },
    publishPost: (postId: string) => {
      const found = rows.find((r) => r.id === postId);
      return Promise.resolve({
        ...found,
        status: 'published',
        targets: [
          {
            channelId: '1',
            platform: 'instagram',
            status: 'published',
            platformPostUrl: 'https://example.test/p/1',
          },
        ],
      });
    },
  } as unknown as PostService;
}

function tool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function build(rows: Record<string, unknown>[], calls: Recorded[] = []) {
  return createPostTools(fakeService(rows, calls), {
    confirmBeforeSend: false,
  });
}

describe('post tools', () => {
  describe('list_posts', () => {
    it('returns each post with a reference so it can be linked', async () => {
      const result = (await tool(build([postRow()]), 'list_posts').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs).toEqual([
        {
          kind: 'draft',
          id: 'p-1',
          label: 'Autumn collection drops Friday',
          status: 'draft',
          platform: 'instagram',
        },
      ]);
    });

    it('labels a published post as a post, not a draft', async () => {
      const result = (await tool(
        build([postRow({ status: 'published' })]),
        'list_posts',
      ).handler({ status: 'published' }, CTX)) as ReferencePayload;

      expect(result.refs[0].kind).toBe('post');
      expect(result.refs[0].status).toBe('published');
    });

    it('shortens a long caption so the chip fits inside a sentence', async () => {
      const long = 'A'.repeat(120);
      const result = (await tool(
        build([postRow({ content: long })]),
        'list_posts',
      ).handler({}, CTX)) as ReferencePayload;

      const label = result.refs[0].label;
      expect(label.length).toBeLessThanOrEqual(81);
      expect(label.endsWith('…')).toBe(true);
    });

    // A chip cut mid-word ("…at our studio this wee…") fails the very request it
    // is answering when the user asked to see the titles.
    it('cuts a long caption at a word, not mid-word', async () => {
      const long =
        'Behind the scenes at our studio this week as we photograph the entire autumn collection';
      const result = (await tool(
        build([postRow({ content: long })]),
        'list_posts',
      ).handler({}, CTX)) as ReferencePayload;

      const label = result.refs[0].label;
      expect(label.endsWith('…')).toBe(true);
      // Whatever it kept, it kept whole words of the original.
      const kept = label.slice(0, -1).trimEnd();
      expect(long.startsWith(kept)).toBe(true);
      expect(long[kept.length]).toBe(' ');
    });

    // A caption that already fits is left exactly as the user wrote it.
    it('leaves a caption that fits completely alone', async () => {
      const short = 'Weekend reading list for founders';
      const result = (await tool(
        build([postRow({ content: short })]),
        'list_posts',
      ).handler({}, CTX)) as ReferencePayload;

      expect(result.refs[0].label).toBe(short);
    });

    it('names a title-only post by its platform title, like the Planner does', async () => {
      // YouTube and Pinterest keep their title in platformContent, not
      // `content` — a chip reading "Untitled post" would not match the UI.
      const result = (await tool(
        build([
          postRow({
            content: null,
            targets: [{ channelId: '9', platform: 'youtube', status: 'draft' }],
            platformContent: {
              youtube: { platformSpecific: { title: 'Behind the scenes' } },
            },
          }),
        ]),
        'list_posts',
      ).handler({}, CTX)) as ReferencePayload;

      expect(result.refs[0].label).toBe('Behind the scenes');
    });

    it('falls back to a readable label when a post has no text at all', async () => {
      const result = (await tool(
        build([postRow({ content: null, platformContent: {} })]),
        'list_posts',
      ).handler({}, CTX)) as ReferencePayload;

      expect(result.refs[0].label).toBe('Untitled post');
    });

    it("reads only the caller's workspace, never one passed as an argument", async () => {
      const calls: Recorded[] = [];
      const result = (await tool(
        build(
          [
            postRow({ id: 'mine', workspaceId: 'ws-1' }),
            postRow({ id: 'theirs', workspaceId: 'ws-2' }),
          ],
          calls,
        ),
        'list_posts',
      ).handler({ workspaceId: 'ws-2' }, CTX)) as ReferencePayload;

      expect(calls[0].workspaceId).toBe('ws-1');
      expect(result.refs.map((r) => r.id)).toEqual(['mine']);
    });

    it('returns an empty reference list rather than nothing when there are no posts', async () => {
      const result = (await tool(build([]), 'list_posts').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs).toEqual([]);
    });
  });

  describe('get_post', () => {
    it('returns the post with a reference so it can be linked', async () => {
      const result = (await tool(build([postRow()]), 'get_post').handler(
        { postId: 'p-1' },
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs[0].id).toBe('p-1');
    });

    it('cannot read a post belonging to another workspace', async () => {
      const result = (await tool(
        build([postRow({ id: 'theirs', workspaceId: 'ws-2' })]),
        'get_post',
      ).handler({ postId: 'theirs' }, CTX)) as { ok?: boolean };

      expect(result.ok).toBe(false);
    });
  });

  describe('publish_post', () => {
    it('cites the post with the status the publish actually reached', async () => {
      const result = (await tool(build([postRow()]), 'publish_post').handler(
        { postId: 'p-1', confirmed: true },
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      // Not 'draft' — the chip must show where the post ended up.
      expect(result.refs[0].status).toBe('published');
      expect(result.refs[0].kind).toBe('post');
    });
  });
});
