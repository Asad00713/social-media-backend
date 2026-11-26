/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
jest.mock('../../drizzle/db', () => {
  const mkChain = (rows: unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows)
          : () => mkChain(rows),
    });
  const dbFake: Record<string, unknown> = {
    insert: () => mkChain([{ id: 'p-new', status: 'draft' }]),
    select: () => mkChain([{ id: 'p1', status: 'draft' }]),
    update: () => mkChain([{ id: 'p1', status: 'draft' }]),
    delete: () => mkChain([]),
    /**
     * `createPost` writes the post and its `post_history` row in one
     * transaction, so the fake has to offer one. It runs the callback with
     * ITSELF as `tx`, so writes inside land in the same `writes` capture the
     * assertions read - a `tx` that swallowed them would make this spec
     * green while the post was never recorded.
     */
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbFake),
    execute: () => mkChain([]),
  };
  return { db: dbFake };
});

import { PostService } from './post.service';

const WS = 'ws1';

function makeService(existing: Record<string, unknown>) {
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
    { send: jest.fn() } as any, // PostReminderService
    { onPublishOutcome: jest.fn(async () => undefined) } as any, // PublishFailureNotifier
    {} as any, // StrandedPostSweeperService
  );
  jest.spyOn(svc, 'getPost').mockResolvedValue(existing as any);
  jest.spyOn(svc as any, 'validateChannels').mockResolvedValue([]);
  jest.spyOn(svc as any, 'recordHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'schedulePublishJob').mockResolvedValue('job');
  jest.spyOn(svc as any, 'cancelScheduledJob').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncCalendarForPost').mockReturnValue(undefined);
  return svc;
}

const OWN_DRAFT = { id: 'p1', status: 'draft', createdById: 'u1', jobId: null };
// A draft a Viewer wrote back when Viewers could draft. No role can draft
// below MEMBER any more, so nobody can write one now; the rows remain.
const FORMER_VIEWER_DRAFT = { ...OWN_DRAFT, createdById: 'former-viewer' };

describe("PostService: members and other people's posts", () => {
  describe('createPost', () => {
    it.each(['MEMBER', 'ADMIN', 'OWNER', 'SUPER_ADMIN'] as const)(
      'a %s schedules',
      async (role) => {
        const svc = makeService(OWN_DRAFT);
        await expect(
          svc.createPost(
            WS,
            'u1',
            {
              content: 'x',
              targetChannelIds: [],
              scheduledAt: new Date(Date.now() + 3_600_000),
            } as any,
            role,
          ),
        ).resolves.toBeDefined();
      },
    );

    it('a MEMBER saves a draft', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.createPost(
          WS,
          'u1',
          { content: 'x', targetChannelIds: [] } as any,
          'MEMBER',
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('updatePost', () => {
    it('a MEMBER edits a draft a former Viewer wrote', async () => {
      const svc = makeService(FORMER_VIEWER_DRAFT);
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'MEMBER'),
      ).resolves.toBeDefined();
    });

    it('a MEMBER may edit a scheduled post made by someone else', async () => {
      const svc = makeService({
        ...OWN_DRAFT,
        status: 'scheduled',
        createdById: 'other',
      });
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'MEMBER'),
      ).resolves.toBeDefined();
    });

    it('internal callers (no role) are unrestricted', async () => {
      const svc = makeService({
        ...OWN_DRAFT,
        status: 'scheduled',
        createdById: 'other',
      });
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any),
      ).resolves.toBeDefined();
    });
  });

  describe('deletePost', () => {
    it('a MEMBER deletes a draft a former Viewer wrote', async () => {
      const svc = makeService(FORMER_VIEWER_DRAFT);
      await expect(
        svc.deletePost('p1', WS, 'u1', 'MEMBER'),
      ).resolves.toBeUndefined();
    });

    it('a MEMBER may delete a scheduled post made by someone else', async () => {
      const svc = makeService({
        ...OWN_DRAFT,
        status: 'scheduled',
        createdById: 'other',
      });
      await expect(
        svc.deletePost('p1', WS, 'u1', 'MEMBER'),
      ).resolves.toBeUndefined();
    });
  });
});
