/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */
import { NotFoundException } from '@nestjs/common';

jest.mock('../../drizzle/db', () => {
  const mkChain = (rows: unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows)
          : () => mkChain(rows),
    });
  return {
    db: {
      insert: () => mkChain([{ id: 'p-new', status: 'draft' }]),
      select: () => mkChain([{ id: 'p1', status: 'draft' }]),
      update: () => mkChain([{ id: 'p1', status: 'draft' }]),
      delete: () => mkChain([]),
      execute: () => mkChain([]),
    },
  };
});

import { PostService } from '../../posts/services/post.service';
import { createPostTools } from './post.tools';

const CTX = { userId: 'u1', workspaceId: 'ws1' };

/** A real PostService (so the Guest rules are the real ones) over mocked IO. */
function realPostService(existing: Record<string, unknown>) {
  const noop = async () => undefined;
  const svc = new PostService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
    { syncPost: noop, loadPostLinks: async () => [] } as any,
    {} as any,
    { enforceQueueLimit: noop } as any,
  );
  jest.spyOn(svc, 'getPost').mockResolvedValue(existing as any);
  jest.spyOn(svc as any, 'validateChannels').mockResolvedValue([]);
  jest.spyOn(svc as any, 'recordHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'schedulePublishJob').mockResolvedValue('job');
  jest.spyOn(svc as any, 'cancelScheduledJob').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncCalendarForPost').mockReturnValue(undefined);
  return svc;
}

function build(
  role: 'GUEST' | 'MEMBER' | 'none',
  existing: Record<string, unknown> = {
    id: 'p1',
    status: 'draft',
    createdById: 'u1',
    jobId: null,
    targets: [],
  },
) {
  const posts = realPostService(existing);
  // The mocked db returns bare rows; give the result the shape the tool reads
  // AFTER the real service (and its Guest rules) has run.
  const realCreate = posts.createPost.bind(posts);
  jest
    .spyOn(posts, 'createPost')
    .mockImplementation(async (...a) => ({
      ...(await realCreate(...a)),
      targets: [],
    }) as any);
  const access = {
    assertCan: jest.fn(async (_w: string, _u: string, cap: string) => {
      if (role === 'none') throw new NotFoundException('Not found');
      if (role === 'GUEST' && cap !== 'posts:draft') {
        throw new NotFoundException('Not found');
      }
      return role;
    }),
  };
  const channels = {
    getChannelById: jest.fn().mockRejectedValue(new Error('no channel')),
  };
  const tools = createPostTools(posts, channels as any, access as any);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { posts, access, tool };
}

const FUTURE = '2030-01-01T10:00:00Z';

describe('chatbot create_post', () => {
  it('a viewer saving a draft is allowed, and the role reaches PostService', async () => {
    const { posts, access, tool } = build('GUEST');
    const spy = jest.spyOn(posts, 'createPost');
    const res = await tool('create_post').execute(
      { content: 'hi', targetChannelIds: [] },
      CTX,
    );
    expect(res.success).toBe(true);
    expect(access.assertCan).toHaveBeenCalledWith('ws1', 'u1', 'posts:draft');
    expect(spy).toHaveBeenCalledWith('ws1', 'u1', expect.anything(), 'GUEST');
  });

  it('a viewer asking to SCHEDULE gets the same refusal as the route', async () => {
    const { tool } = build('GUEST');
    const res = await tool('create_post').execute(
      { content: 'hi', targetChannelIds: [], scheduledAt: FUTURE },
      CTX,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('Only members can schedule posts');
  });

  it('a member may schedule', async () => {
    const { tool } = build('MEMBER');
    const res = await tool('create_post').execute(
      { content: 'hi', targetChannelIds: [], scheduledAt: FUTURE },
      CTX,
    );
    expect(res.success).toBe(true);
  });

  it('a non-member is refused before anything is created', async () => {
    const { posts, tool } = build('none');
    const spy = jest.spyOn(posts, 'createPost');
    const res = await tool('create_post').execute(
      { content: 'hi', targetChannelIds: [] },
      CTX,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('does not allow');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chatbot update_post', () => {
  it('a viewer may edit their own draft', async () => {
    const { tool } = build('GUEST');
    const res = await tool('update_post').execute(
      { postId: 'p1', content: 'new' },
      CTX,
    );
    expect(res.success).toBe(true);
  });

  it('a viewer cannot schedule an existing draft', async () => {
    const { tool } = build('GUEST');
    const res = await tool('update_post').execute(
      { postId: 'p1', scheduledAt: FUTURE },
      CTX,
    );
    expect(res.success).toBe(false);
  });

  it("a viewer cannot edit someone else's post", async () => {
    const { tool } = build('GUEST', {
      id: 'p1',
      status: 'draft',
      createdById: 'someone-else',
      jobId: null,
    });
    const res = await tool('update_post').execute(
      { postId: 'p1', content: 'x' },
      CTX,
    );
    expect(res.success).toBe(false);
  });

  it('a non-member is refused', async () => {
    const { posts, tool } = build('none');
    const spy = jest.spyOn(posts, 'updatePost');
    const res = await tool('update_post').execute(
      { postId: 'p1', content: 'x' },
      CTX,
    );
    expect(res.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chatbot delete_post', () => {
  it('a viewer may delete their own draft', async () => {
    const { tool } = build('GUEST');
    const res = await tool('delete_post').execute({ postId: 'p1' }, CTX);
    expect(res.success).toBe(true);
  });

  it('a viewer cannot delete a scheduled post', async () => {
    const { tool } = build('GUEST', {
      id: 'p1',
      status: 'scheduled',
      createdById: 'u1',
      jobId: 'j',
    });
    const res = await tool('delete_post').execute({ postId: 'p1' }, CTX);
    expect(res.success).toBe(false);
  });

  it('a member may delete a scheduled post', async () => {
    const { tool } = build('MEMBER', {
      id: 'p1',
      status: 'scheduled',
      createdById: 'someone-else',
      jobId: 'j',
    });
    const res = await tool('delete_post').execute({ postId: 'p1' }, CTX);
    expect(res.success).toBe(true);
  });

  it('a non-member is refused', async () => {
    const { posts, tool } = build('none');
    const spy = jest.spyOn(posts, 'deletePost');
    const res = await tool('delete_post').execute({ postId: 'p1' }, CTX);
    expect(res.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chatbot read tools', () => {
  it('list_posts does not consult the access service', async () => {
    const { posts, access, tool } = build('GUEST');
    jest
      .spyOn(posts, 'getWorkspacePosts' as any)
      .mockResolvedValue({ posts: [], total: 0 } as any);
    await tool('list_posts').execute({}, CTX);
    expect(access.assertCan).not.toHaveBeenCalled();
  });
});
