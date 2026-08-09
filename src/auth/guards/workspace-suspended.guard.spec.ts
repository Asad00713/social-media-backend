import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceSuspendedGuard } from './workspace-suspended.guard';

/**
 * Builds a fake Drizzle `db` whose `select().from().where().limit()` chain
 * resolves to queued row-sets in sequence — the guard now issues two queries
 * (workspace row, then subscription row), so each call to `limit()` pops the
 * next queued result. Pass one array per expected query, in call order.
 */
function mockDb(...rowsQueue: Array<Array<Record<string, unknown>>>) {
  const queue = [...rowsQueue];
  const limit = jest.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? []));
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where, limit };
}

function mockContext(params: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockReflector(skip: boolean): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(skip) } as unknown as Reflector;
}

describe('WorkspaceSuspendedGuard', () => {
  it('allows routes marked @SkipSuspendCheck without touching the DB', async () => {
    const { db, select } = mockDb([]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(true));

    await expect(
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
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
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
    ).resolves.toBe(true);
  });

  it('allows an active workspace with no subscription row (free / never subscribed)', async () => {
    const { db } = mockDb([{ isActive: true, reason: null }], []);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
    ).resolves.toBe(true);
  });

  it.each(['active', 'trialing', 'past_due', 'incomplete', 'canceled'])(
    'allows non-suspended status "%s"',
    async (status) => {
      const { db } = mockDb([{ isActive: true, reason: null }], [{ status }]);
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
      ).resolves.toBe(true);
    },
  );

  it.each(['unpaid', 'incomplete_expired'])(
    'blocks suspended status "%s" with a WORKSPACE_SUSPENDED 403 carrying reason "billing"',
    async (status) => {
      const { db } = mockDb([{ isActive: true, reason: null }], [{ status }]);
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
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

  it('reads the analytics module\'s :wsId param too', async () => {
    const { db, where } = mockDb([{ isActive: true, reason: null }], [{ status: 'unpaid' }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ wsId: 'ws-2' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(where).toHaveBeenCalled();
  });

  it('blocks a manually-suspended workspace (isActive=false) with reason from suspendedReason', async () => {
    const { db } = mockDb([{ isActive: false, reason: 'policy_violation' }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
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
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
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
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Only one query (the workspace lookup) should have run.
    expect(select).toHaveBeenCalledTimes(1);
  });
});
