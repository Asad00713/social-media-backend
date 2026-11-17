import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceSuspendedGuard } from './workspace-suspended.guard';

/**
 * Builds a fake Drizzle `db` whose `select().from().where().limit()` chain
 * resolves to queued row-sets in sequence — the guard now issues two queries
 * (workspace row, then subscription row), so each call to `limit()` pops the
 * next queued result. Pass one array per expected query, in call order.
 *
 * The workspace row must carry `ownerId`: subscriptions are account-scoped, so
 * the guard looks the subscription up by owner. A fixture without one models a
 * workspace whose owner cannot be resolved, and the guard then allows through.
 */
const WS_1 = '0b6f2a44-6a47-4c1e-9b1e-3f1d2a5c7e01';
const WS_2 = '6d9c1e2f-3b4a-4f5e-8a7b-9c0d1e2f3a42';

function mockDb(...rowsQueue: Array<Array<Record<string, unknown>>>) {
  const queue = [...rowsQueue];
  const limit = jest
    .fn()
    .mockImplementation(() => Promise.resolve(queue.shift() ?? []));
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where, limit };
}

function mockContext(
  params: Record<string, string | undefined>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockReflector(skip: boolean): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(skip),
  } as unknown as Reflector;
}

describe('WorkspaceSuspendedGuard', () => {
  // Every workspace id is a uuid column: handing Postgres anything else throws
  // "invalid input syntax for type uuid", which surfaced as a 500 on every
  // workspace route — before auth, since this guard is global.
  it.each([
    ['workspaceId', 'probe'],
    ['workspaceId', 'not-a-uuid-at-all'],
    ['wsId', '123'],
  ])(
    'rejects a malformed %s (%s) with 400 and never queries the DB',
    async (param, value) => {
      const { db, select } = mockDb([]);
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ [param]: value })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it('allows routes marked @SkipSuspendCheck without touching the DB', async () => {
    const { db, select } = mockDb([]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(true));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it('allows non-workspace routes (no workspaceId / wsId param)', async () => {
    const { db, select } = mockDb([]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(guard.canActivate(mockContext({}))).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it('allows a workspace with no workspace row and no subscription row', async () => {
    const { db } = mockDb([], []);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).resolves.toBe(true);
  });

  it('allows an active workspace with no subscription row (free / never subscribed)', async () => {
    const { db } = mockDb(
      [{ isActive: true, reason: null, ownerId: 'owner-1' }],
      [],
    );
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).resolves.toBe(true);
  });

  it.each(['active', 'trialing', 'past_due', 'incomplete', 'canceled'])(
    'allows non-suspended status "%s"',
    async (status) => {
      const { db } = mockDb(
        [{ isActive: true, reason: null, ownerId: 'owner-1' }],
        [{ status }],
      );
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: WS_1 })),
      ).resolves.toBe(true);
    },
  );

  it.each(['unpaid', 'incomplete_expired'])(
    'blocks suspended status "%s" with a WORKSPACE_SUSPENDED 403 carrying reason "billing"',
    async (status) => {
      const { db } = mockDb(
        [{ isActive: true, reason: null, ownerId: 'owner-1' }],
        [{ status }],
      );
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: WS_1 })),
      ).rejects.toMatchObject({
        response: {
          statusCode: 403,
          error: 'Forbidden',
          code: 'WORKSPACE_SUSPENDED',
          reason: 'billing',
          status,
          message: expect.any(String),
        },
      });
    },
  );

  it("reads the analytics module's :wsId param too", async () => {
    const { db, where } = mockDb(
      [{ isActive: true, reason: null, ownerId: 'owner-1' }],
      [{ status: 'unpaid' }],
    );
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ wsId: WS_2 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(where).toHaveBeenCalled();
  });

  it('blocks a manually-suspended workspace (isActive=false) with reason from suspendedReason', async () => {
    const { db } = mockDb([{ isActive: false, reason: 'policy_violation' }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).rejects.toMatchObject({
      response: {
        statusCode: 403,
        error: 'Forbidden',
        code: 'WORKSPACE_SUSPENDED',
        reason: 'policy_violation',
        message: expect.any(String),
      },
    });
  });

  it('blocks a manually-suspended workspace with no suspendedReason, defaulting reason to "manual"', async () => {
    const { db } = mockDb([{ isActive: false, reason: null }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).rejects.toMatchObject({
      response: {
        statusCode: 403,
        error: 'Forbidden',
        code: 'WORKSPACE_SUSPENDED',
        reason: 'manual',
        message: expect.any(String),
      },
    });
  });

  it('manual suspension short-circuits before the subscription query', async () => {
    const { db, select } = mockDb([{ isActive: false, reason: 'abuse' }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Only one query (the workspace lookup) should have run.
    expect(select).toHaveBeenCalledTimes(1);
  });
});

/**
 * Soft delete (migration 0088).
 *
 * This guard is the single place a deleted workspace is refused. The
 * membership checks scattered across the app read `workspaceInvitation`, not
 * `workspace`, so they cannot see that a workspace was deleted — an accepted
 * member would otherwise keep full access to a workspace its owner removed,
 * while the owner themselves was correctly shut out. A security review caught
 * exactly that asymmetry.
 */
describe('WorkspaceSuspendedGuard and soft-deleted workspaces', () => {
  it('answers 404 for a soft-deleted workspace', async () => {
    const { db } = mockDb([
      {
        isActive: true,
        reason: null,
        ownerId: 'owner-1',
        deletedAt: new Date('2026-11-01T00:00:00.000Z'),
      },
    ]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The reason the guard reads `deleted_at` instead of filtering on it. A
   * filtered query returns no row for a deleted workspace, and "no row" is
   * this guard's signal that there is nothing to enforce — so it would wave
   * the request straight through, which is the opposite of what is wanted.
   */
  it('does not treat a deleted workspace as "nothing to enforce"', async () => {
    const { db, where } = mockDb([
      { isActive: true, reason: null, ownerId: 'o', deletedAt: new Date() },
    ]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).rejects.toBeInstanceOf(NotFoundException);

    // One query, and it must not have excluded the deleted row.
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('lets a live workspace through as before', async () => {
    const { db } = mockDb(
      [{ isActive: true, reason: null, ownerId: 'owner-1', deletedAt: null }],
      [],
    );
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_2 })),
    ).resolves.toBe(true);
  });

  it('still allows a workspace that does not exist at all', async () => {
    const { db } = mockDb([], []);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: WS_1 })),
    ).resolves.toBe(true);
  });
});
