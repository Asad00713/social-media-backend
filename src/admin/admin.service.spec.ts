import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { SessionStore } from '../auth/session/session-store';
import type { SecondFactorService } from '../auth/two-factor/second-factor.service';
import type { TwoFactorNotices } from '../auth/two-factor/two-factor-notices.service';
import { AUDIT_ACTIONS } from '../drizzle/schema';
import type { DbType } from '../drizzle/db';
import type { AdminAuditService } from './admin-audit.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

/**
 * AdminService.resetTwoFactor with a fake db: the one `select` resolves to
 * the queued user, and the transaction hands the callback a marker `tx`, so
 * the test sees clear + revokeAll ran on it (one transaction), not on the db.
 */
function setup(
  user: { id: string; email: string; totpEnabledAt: Date | null } | null,
) {
  const order: string[] = [];
  const tx = { tx: true };
  const db = {
    select: jest.fn(() => {
      const b: Record<string, unknown> = {};
      b.from = () => b;
      b.where = () => b;
      b.limit = () => Promise.resolve(user ? [user] : []);
      return b;
    }),
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      order.push('tx:begin');
      const out = await fn(tx);
      order.push('tx:commit');
      return out;
    }),
  };
  const step = (name: string, value?: unknown) =>
    jest.fn(() => {
      order.push(name);
      return Promise.resolve(value);
    });
  const secondFactor = { clear: step('clear') };
  const sessions = { revokeAll: step('revokeAll', 2) };
  const audit = { record: step('audit') };
  const notices = { disabledBySupport: step('email') };
  const service = new AdminService(
    db as unknown as DbType,
    audit as unknown as AdminAuditService,
    secondFactor as unknown as SecondFactorService,
    sessions as unknown as SessionStore,
    notices as unknown as TwoFactorNotices,
  );
  return { service, db, tx, secondFactor, sessions, audit, notices, order };
}

describe('AdminService.resetTwoFactor', () => {
  it('clears two-step and revokes every session in one transaction, then audits user.2fa_reset and emails by support', async () => {
    const t = setup({
      id: USER_ID,
      email: 'sara@example.test',
      totpEnabledAt: new Date(),
    });

    await expect(t.service.resetTwoFactor(ADMIN_ID, USER_ID)).resolves.toEqual({
      success: true,
      message:
        'Two-step sign-in was turned off and every session was signed out.',
    });

    expect(t.secondFactor.clear).toHaveBeenCalledWith(USER_ID, t.tx);
    expect(t.sessions.revokeAll).toHaveBeenCalledWith(USER_ID, t.tx);
    expect(t.audit.record).toHaveBeenCalledWith({
      action: 'user.2fa_reset',
      actorId: ADMIN_ID,
      targetType: 'user',
      targetId: USER_ID,
      targetLabel: 'sara@example.test',
    });
    expect(t.notices.disabledBySupport).toHaveBeenCalledWith(USER_ID);
    // The audit row and the email only after the reset committed.
    expect(t.order).toEqual([
      'tx:begin',
      'clear',
      'revokeAll',
      'tx:commit',
      'audit',
      'email',
    ]);
  });

  it('a user without two-step: 409 MFA_NOT_ENABLED, nothing cleared, no audit, no email', async () => {
    const t = setup({
      id: USER_ID,
      email: 'sara@example.test',
      totpEnabledAt: null,
    });

    await expect(
      t.service.resetTwoFactor(ADMIN_ID, USER_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MFA_NOT_ENABLED' },
    });
    expect(t.db.transaction).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.notices.disabledBySupport).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown user', USER_ID],
    ['a malformed id (never sent to Postgres as a uuid)', 'not-a-uuid'],
  ])('%s: 404, nothing written', async (_label, id) => {
    const t = setup(null);

    await expect(t.service.resetTwoFactor(ADMIN_ID, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.db.transaction).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('user.2fa_reset is an audit action and fits the varchar(40) column', () => {
    expect(AUDIT_ACTIONS).toContain('user.2fa_reset');
    expect('user.2fa_reset'.length).toBeLessThanOrEqual(40);
  });
});

describe('POST /admin/users/:userId/2fa/reset', () => {
  const handler = (): object =>
    Reflect.get(AdminController.prototype, 'resetTwoFactor') as object;

  it('is POST users/:userId/2fa/reset answering 200 on AdminController', () => {
    expect(Reflect.getMetadata('path', AdminController)).toBe('admin');
    expect(Reflect.getMetadata('path', handler())).toBe(
      'users/:userId/2fa/reset',
    );
    expect(Reflect.getMetadata('method', handler())).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler())).toBe(200);
  });

  it('is behind JwtAuthGuard and SuperAdminGuard (the class guards)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminController,
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, SuperAdminGuard]);
    // Nothing on the handler adds to or replaces them.
    expect(Reflect.getMetadata(GUARDS_METADATA, handler())).toBeUndefined();
  });

  it('resets the :userId of the URL as the calling admin', async () => {
    const adminService = {
      resetTwoFactor: jest.fn().mockResolvedValue({ success: true }),
    };
    const rest = Array.from({ length: 8 }, () => ({})) as never[];
    const controller = new (AdminController as unknown as new (
      ...args: unknown[]
    ) => AdminController)(adminService, ...rest);

    await controller.resetTwoFactor(USER_ID, { userId: ADMIN_ID });

    expect(adminService.resetTwoFactor).toHaveBeenCalledWith(ADMIN_ID, USER_ID);
  });
});
