import { AdminAuditService } from './admin-audit.service';

function makeDb(overrides: Partial<any> = {}) {
  const inserted: any[] = [];
  const db: any = {
    inserted,
    query: {
      users: {
        findFirst: jest.fn().mockResolvedValue({ email: 'admin@x.com' }),
      },
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
    ...overrides,
  };
  return db;
}

describe('AdminAuditService.record', () => {
  it('inserts a row with resolved actor email', async () => {
    const db = makeDb();
    const svc = new AdminAuditService(db);
    await svc.record({
      action: 'user.suspend',
      actorId: 'admin-1',
      targetType: 'user',
      targetId: 'user-9',
      targetLabel: 'joe@x.com',
      reason: 'spam',
    });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      action: 'user.suspend',
      actorId: 'admin-1',
      actorEmail: 'admin@x.com',
      targetType: 'user',
      targetId: 'user-9',
      targetLabel: 'joe@x.com',
      reason: 'spam',
    });
  });

  it('never throws when the insert fails', async () => {
    const db = makeDb({
      insert: () => ({ values: () => Promise.reject(new Error('db down')) }),
    });
    const svc = new AdminAuditService(db);
    await expect(
      svc.record({
        action: 'user.suspend',
        actorId: 'a',
        targetType: 'user',
        targetId: 'u',
      }),
    ).resolves.toBeUndefined();
  });

  it('stores null actor email when the actor is missing', async () => {
    const db = makeDb({
      query: { users: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    });
    const svc = new AdminAuditService(db);
    await svc.record({
      action: 'user.reactivate',
      actorId: 'ghost',
      targetType: 'user',
      targetId: 'u',
    });
    expect(db.inserted[0].actorEmail).toBeNull();
  });
});

function makeSelectDb(rows: any[]) {
  // Model select().from().where().orderBy().limit(n) → first n rows of `rows`.
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
  };
  return { select: () => chain } as any;
}

describe('AdminAuditService.getAudit pagination', () => {
  const row = (i: number) => ({
    id: `id-${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  });

  it('returns nextCursor=null when a page is not full', async () => {
    const svc = new AdminAuditService(makeSelectDb([row(1), row(2)]));
    const res = await svc.getAudit({});
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBeNull();
  });

  it('returns 50 items + a cursor on the 50th row when a 51st exists', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(i));
    const svc = new AdminAuditService(makeSelectDb(rows));
    const res = await svc.getAudit({});
    expect(res.items).toHaveLength(50);
    expect(res.nextCursor).toContain('id-49'); // 50th row (0-indexed)
    // The cursor row id must NOT be in the returned page's tail boundary re-fetch:
    expect(res.items.map((r: any) => r.id)).not.toContain('id-50');
  });
});
