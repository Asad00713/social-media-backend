/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */
import { ForbiddenException } from '@nestjs/common';

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

describe('PostService Guest rules (role GUEST = viewer)', () => {
  describe('createPost', () => {
    it('refuses a scheduled post', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.createPost(
          WS,
          'u1',
          {
            content: 'x',
            targetChannelIds: [],
            scheduledAt: new Date(),
          } as any,
          'GUEST',
        ),
      ).rejects.toThrow(
        new ForbiddenException('Only members can schedule posts'),
      );
    });

    it('allows a draft', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.createPost(
          WS,
          'u1',
          { content: 'x', targetChannelIds: [] } as any,
          'GUEST',
        ),
      ).resolves.toBeDefined();
    });

    it.each(['MEMBER', 'ADMIN', 'OWNER', 'SUPER_ADMIN'] as const)(
      '%s may still schedule',
      async (role) => {
        const svc = makeService(OWN_DRAFT);
        await expect(
          svc.createPost(
            WS,
            'u1',
            {
              content: 'x',
              targetChannelIds: [],
              scheduledAt: new Date(),
            } as any,
            role,
          ),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('updatePost', () => {
    it('refuses a post that is not a draft', async () => {
      const svc = makeService({ ...OWN_DRAFT, status: 'scheduled' });
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a change to scheduledAt, even null', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.updatePost('p1', WS, 'u1', { scheduledAt: null } as any, 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.updatePost(
          'p1',
          WS,
          'u1',
          { scheduledAt: new Date() } as any,
          'GUEST',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses someone else's draft", async () => {
      const svc = makeService({ ...OWN_DRAFT, createdById: 'other' });
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows editing their own draft', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'GUEST'),
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
    it('refuses a non-draft', async () => {
      const svc = makeService({ ...OWN_DRAFT, status: 'failed' });
      await expect(
        svc.deletePost('p1', WS, 'u1', 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses someone else's draft", async () => {
      const svc = makeService({ ...OWN_DRAFT, createdById: 'other' });
      await expect(
        svc.deletePost('p1', WS, 'u1', 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows deleting their own draft', async () => {
      const svc = makeService(OWN_DRAFT);
      await expect(
        svc.deletePost('p1', WS, 'u1', 'GUEST'),
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
