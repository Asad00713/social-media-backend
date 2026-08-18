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
