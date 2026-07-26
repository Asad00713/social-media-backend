import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceSuspendedGuard } from './workspace-suspended.guard';

/**
 * Builds a fake Drizzle `db` whose
 * `select().from().where().limit()` chain resolves to `rows`.
 */
function mockDb(rows: Array<{ status: string }>) {
  const limit = jest.fn().mockResolvedValue(rows);
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

  it('allows a workspace with no subscription row (free / never subscribed)', async () => {
    const { db } = mockDb([]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
    ).resolves.toBe(true);
  });

  it.each(['active', 'trialing', 'past_due', 'incomplete', 'canceled'])(
    'allows non-suspended status "%s"',
    async (status) => {
      const { db } = mockDb([{ status }]);
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
      ).resolves.toBe(true);
    },
  );

  it.each(['unpaid', 'incomplete_expired'])(
    'blocks suspended status "%s" with a WORKSPACE_SUSPENDED 403',
    async (status) => {
      const { db } = mockDb([{ status }]);
      const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

      await expect(
        guard.canActivate(mockContext({ workspaceId: 'ws-1' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('reads the analytics module\'s :wsId param too', async () => {
    const { db, where } = mockDb([{ status: 'unpaid' }]);
    const guard = new WorkspaceSuspendedGuard(db, mockReflector(false));

    await expect(
      guard.canActivate(mockContext({ wsId: 'ws-2' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(where).toHaveBeenCalled();
  });
});
