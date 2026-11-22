import {
  ForbiddenException,
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import type { SubscriptionService } from '../billing/services/subscription.service';
import type { UsageService } from '../billing/services/usage.service';
import type { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { mfaCodeInvalid } from '../auth/two-factor/mfa-errors';
import {
  requireOneFactor,
  type SecondFactorInput,
  type SecondFactorService,
} from '../auth/two-factor/second-factor.service';
import { AccountDeletionService } from './account-deletion.service';

/** The one TOTP and the one backup code the fake second factor accepts. */
const GOOD_TOTP = '123456';
const GOOD_BACKUP = 'abcd-efgh';

/**
 * The checks that run BEFORE anything is written, with a fake db: each
 * `select` chain resolves to the next queued result. What the transaction
 * writes is proven against Postgres in account-deletion.db.spec.ts.
 */
function setup(opts: {
  user?: { email: string; deletedAt: Date | null; role?: string } | null;
  owned?: { id: string; name: string }[];
  cancel?: () => Promise<unknown>;
  leftWorkspaces?: string[] | null;
  avatarUrl?: string | null;
  ownAvatar?: boolean;
  deleteObject?: () => Promise<void>;
  twoFactor?: boolean;
}) {
  const queue: unknown[][] = [
    opts.user === null
      ? []
      : [opts.user ?? { email: 'old@example.com', deletedAt: null }],
    opts.owned ?? [],
  ];
  const chain = () => {
    const result = queue.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'for']) {
      builder[m] = () => builder;
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  const db = {
    select: jest.fn(chain),
    transaction: jest.fn().mockResolvedValue(
      opts.leftWorkspaces === null
        ? null
        : {
            seatWorkspaces: opts.leftWorkspaces ?? [],
            avatarUrl: opts.avatarUrl ?? null,
          },
    ),
  };
  const subscriptions = {
    cancelForAccount: jest.fn(opts.cancel ?? (() => Promise.resolve('none'))),
  };
  const usage = {
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  // Never the real R2 client: only these three calls exist.
  const r2 = {
    isOwnPublicUrl: jest.fn(() => opts.ownAvatar ?? true),
    keyFromPublicUrl: jest.fn((url: string) =>
      url.slice('https://cdn.test/'.length),
    ),
    deleteObject: jest.fn(opts.deleteObject ?? (() => Promise.resolve())),
  };
  // The real "exactly one" rule; a right answer is GOOD_TOTP / GOOD_BACKUP.
  const secondFactor = {
    isEnabled: jest.fn(() => Promise.resolve(opts.twoFactor ?? false)),
    check: jest.fn((_userId: string, input: SecondFactorInput) => {
      requireOneFactor(input);
      if (input.code === GOOD_TOTP || input.backupCode === GOOD_BACKUP) {
        return Promise.resolve({
          method: input.code ? 'totp' : 'backup',
          backupCodesRemaining: 9,
        });
      }
      return Promise.reject(mfaCodeInvalid());
    }),
  };
  const notifications = { disconnectUser: jest.fn() };
  const realtime = { disconnectUser: jest.fn() };
  const service = new AccountDeletionService(
    db as unknown as DbType,
    subscriptions as unknown as SubscriptionService,
    usage as unknown as UsageService,
    r2 as unknown as CloudflareR2Service,
    secondFactor as unknown as SecondFactorService,
    notifications as never,
    realtime as never,
  );
  return {
    service,
    db,
    subscriptions,
    usage,
    r2,
    secondFactor,
    notifications,
    realtime,
  };
}

const SELF = (confirmEmail?: string) => ({
  confirmEmail,
  actor: 'self' as const,
  actorId: 'u1',
});

describe('AccountDeletionService.deleteAccount, two-step on', () => {
  const withFactor = (factor: { code?: string; backupCode?: string }) => ({
    ...SELF('old@example.com'),
    ...factor,
  });

  it('no code: 400 MFA_CODE_REQUIRED, nothing deleted, billing untouched', async () => {
    const { service, db, subscriptions } = setup({ twoFactor: true });

    await expect(
      service.deleteAccount('u1', withFactor({})),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'MFA_CODE_REQUIRED' },
    });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a wrong code: 400 MFA_CODE_INVALID, nothing deleted, billing untouched', async () => {
    const { service, db, subscriptions } = setup({ twoFactor: true });

    await expect(
      service.deleteAccount('u1', withFactor({ code: '000000' })),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'MFA_CODE_INVALID' },
    });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a 6-digit `code` is checked as a TOTP and deletes', async () => {
    const { service, db, secondFactor } = setup({ twoFactor: true });

    await service.deleteAccount('u1', withFactor({ code: GOOD_TOTP }));

    expect(secondFactor.check).toHaveBeenCalledWith('u1', { code: GOOD_TOTP });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('a backup code sent in the `code` field ("abcd-efgh") is checked as a backup code and deletes', async () => {
    const { service, db, secondFactor } = setup({ twoFactor: true });

    await service.deleteAccount('u1', withFactor({ code: GOOD_BACKUP }));

    expect(secondFactor.check).toHaveBeenCalledWith('u1', {
      backupCode: GOOD_BACKUP,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('`backupCode` is accepted too; `code` and `backupCode` together are refused', async () => {
    const ok = setup({ twoFactor: true });
    await ok.service.deleteAccount(
      'u1',
      withFactor({ backupCode: GOOD_BACKUP }),
    );
    expect(ok.db.transaction).toHaveBeenCalledTimes(1);

    const both = setup({ twoFactor: true });
    await expect(
      both.service.deleteAccount(
        'u1',
        withFactor({ code: GOOD_TOTP, backupCode: GOOD_BACKUP }),
      ),
    ).rejects.toMatchObject({ response: { code: 'MFA_CODE_REQUIRED' } });
    expect(both.db.transaction).not.toHaveBeenCalled();
  });

  it('a wrong email is EMAIL_MISMATCH before any code is judged', async () => {
    const { service, secondFactor } = setup({ twoFactor: true });

    await expect(
      service.deleteAccount('u1', {
        ...SELF('other@x.com'),
        code: GOOD_TOTP,
      }),
    ).rejects.toMatchObject({ response: { code: 'EMAIL_MISMATCH' } });
    expect(secondFactor.check).not.toHaveBeenCalled();
  });

  it('an owner gets 409 OWNS_WORKSPACES without spending a code', async () => {
    const { service, secondFactor } = setup({
      twoFactor: true,
      owned: [{ id: 'w1', name: 'Mine' }],
    });

    await expect(
      service.deleteAccount('u1', withFactor({ code: GOOD_BACKUP })),
    ).rejects.toMatchObject({ response: { code: 'OWNS_WORKSPACES' } });
    expect(secondFactor.check).not.toHaveBeenCalled();
  });

  it('two-step off: no code is asked for', async () => {
    const { service, db, secondFactor } = setup({ twoFactor: false });

    await service.deleteAccount('u1', withFactor({}));

    expect(secondFactor.check).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('an admin delete of a 2FA user needs no code', async () => {
    const { service, db, secondFactor } = setup({ twoFactor: true });

    await service.deleteAccount('u1', {
      actor: 'super_admin',
      actorId: 'admin-1',
    });

    expect(secondFactor.check).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('AccountDeletionService.deleteAccount', () => {
  it('the typed email matches trimmed and case-insensitively', async () => {
    const { service, db, subscriptions } = setup({});

    await service.deleteAccount('u1', SELF(' Old@Example.com '));

    expect(subscriptions.cancelForAccount).toHaveBeenCalledWith('u1', false, {
      changedByUserId: 'u1',
      goneIsCancelled: true,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('a different email is 400 EMAIL_MISMATCH, before billing or any write', async () => {
    const { service, db, subscriptions } = setup({});

    const result = service.deleteAccount('u1', SELF('other@x.com'));
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'EMAIL_MISMATCH' },
    });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a missing confirmEmail is a mismatch for `self`', async () => {
    const { service } = setup({});
    await expect(service.deleteAccount('u1', SELF())).rejects.toMatchObject({
      response: { code: 'EMAIL_MISMATCH' },
    });
  });

  it('a super admin deletes without the email', async () => {
    const { service, db } = setup({});
    await service.deleteAccount('u1', {
      actor: 'super_admin',
      actorId: 'admin-1',
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('an owner gets 409 OWNS_WORKSPACES listing {id, name}, and nothing happens', async () => {
    const owned = [
      { id: 'w1', name: 'Acme' },
      { id: 'w2', name: 'Beta' },
    ];
    const { service, db, subscriptions } = setup({ owned });

    const result = service.deleteAccount('u1', SELF('old@example.com'));
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'OWNS_WORKSPACES', workspaces: owned },
    });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a billing cancel failure is 502 BILLING_CANCEL_FAILED and nothing is written', async () => {
    const { service, db } = setup({
      cancel: () => Promise.reject(new Error('provider down')),
    });

    const result = service.deleteAccount('u1', SELF('old@example.com'));
    await expect(result).rejects.toBeInstanceOf(BadGatewayException);
    await expect(result).rejects.toMatchObject({
      response: { statusCode: 502, code: 'BILLING_CANCEL_FAILED' },
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('cancels immediately (not at period end), with the admin as the actor for an admin delete', async () => {
    const { service, subscriptions } = setup({});
    await service.deleteAccount('u1', {
      actor: 'super_admin',
      actorId: 'admin-1',
    });
    expect(subscriptions.cancelForAccount).toHaveBeenCalledWith('u1', false, {
      changedByUserId: 'admin-1',
      goneIsCancelled: true,
    });
  });

  it('a super admin target is 403 SUPER_ADMIN_NOT_DELETABLE from the admin tool, before billing or any write', async () => {
    const { service, db, subscriptions } = setup({
      user: { email: 'boss@example.com', deletedAt: null, role: 'SUPER_ADMIN' },
    });
    const result = service.deleteAccount('u1', {
      actor: 'super_admin',
      actorId: 'admin-1',
    });
    await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'SUPER_ADMIN_NOT_DELETABLE' },
    });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a super admin may still delete their own account with the typed email', async () => {
    const { service, db } = setup({
      user: { email: 'boss@example.com', deletedAt: null, role: 'SUPER_ADMIN' },
    });
    await service.deleteAccount('u1', {
      confirmEmail: 'boss@example.com',
      actor: 'self',
      actorId: 'u1',
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("after commit, the deleted account's live sockets are closed on both gateways", async () => {
    const { service, db, notifications, realtime } = setup({});
    await service.deleteAccount('u1', SELF('old@example.com'));
    expect(notifications.disconnectUser).toHaveBeenCalledWith('u1');
    expect(realtime.disconnectUser).toHaveBeenCalledWith('u1');
    expect(db.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.disconnectUser.mock.invocationCallOrder[0],
    );
  });

  it('a socket failure never fails the delete', async () => {
    const { service, notifications } = setup({});
    notifications.disconnectUser.mockImplementation(() => {
      throw new Error('no server yet');
    });
    await expect(
      service.deleteAccount('u1', SELF('old@example.com')),
    ).resolves.toBeUndefined();
  });

  it('a delete that lost the race (transaction returns null) closes no socket', async () => {
    const { service, notifications } = setup({ leftWorkspaces: null });
    await service.deleteAccount('u1', SELF('old@example.com'));
    expect(notifications.disconnectUser).not.toHaveBeenCalled();
  });

  it('an unknown user is 404', async () => {
    const { service } = setup({ user: null });
    await expect(
      service.deleteAccount('nope', SELF('old@example.com')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an already-deleted account is a no-op', async () => {
    const { service, db, subscriptions } = setup({
      user: { email: 'deleted+u1@deleted.invalid', deletedAt: new Date() },
    });
    await service.deleteAccount('u1', { actor: 'super_admin', actorId: 'a' });
    expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('no member count is moved after commit: the seats move on the transaction (account-deletion.db.spec)', async () => {
    const { service, usage } = setup({ leftWorkspaces: ['w1', 'w2'] });
    await service.deleteAccount('u1', SELF('old@example.com'));
    // The transaction is faked here, so nothing inside it runs.
    expect(usage.decrementMemberCount).not.toHaveBeenCalled();
  });

  describe('avatar removal after commit', () => {
    // In u1's own folder: avatars/<safeKeyUserId('u1')>/.
    const URL =
      'https://cdn.test/avatars/u1/1700000000000-0123456789abcdef01234567.png';

    it('deletes exactly the object the avatar URL names, as an avatar key', async () => {
      const { service, r2 } = setup({ avatarUrl: URL });
      await service.deleteAccount('u1', SELF('old@example.com'));
      expect(r2.isOwnPublicUrl).toHaveBeenCalledWith(URL, 'avatar');
      expect(r2.deleteObject).toHaveBeenCalledTimes(1);
      expect(r2.deleteObject).toHaveBeenCalledWith(
        'avatars/u1/1700000000000-0123456789abcdef01234567.png',
      );
    });

    it('a storage failure is logged and never fails the delete', async () => {
      const { service, r2 } = setup({
        avatarUrl: URL,
        deleteObject: () => Promise.reject(new Error('r2 down')),
      });
      await expect(
        service.deleteAccount('u1', SELF('old@example.com')),
      ).resolves.toBeUndefined();
      expect(r2.deleteObject).toHaveBeenCalledTimes(1);
    });

    it('no avatar, or a URL that is not one of our avatar keys: nothing deleted', async () => {
      const none = setup({ avatarUrl: null });
      await none.service.deleteAccount('u1', SELF('old@example.com'));
      expect(none.r2.deleteObject).not.toHaveBeenCalled();

      const foreign = setup({
        avatarUrl: 'https://elsewhere.test/me.png',
        ownAvatar: false,
      });
      await foreign.service.deleteAccount('u1', SELF('old@example.com'));
      expect(foreign.r2.deleteObject).not.toHaveBeenCalled();
    });

    it("an avatar in ANOTHER user's folder is never deleted, and the account delete still succeeds", async () => {
      // u1 had set their avatar to u2's picture (a valid avatar key of ours).
      const theirs =
        'https://cdn.test/avatars/u2/1700000000000-0123456789abcdef01234567.png';
      const { service, db, r2 } = setup({ avatarUrl: theirs });
      await expect(
        service.deleteAccount('u1', SELF('old@example.com')),
      ).resolves.toBeUndefined();
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('a folder that only starts with the same characters is not ours', async () => {
      // 'u1' must match the whole segment, not a prefix of 'u10'.
      const near =
        'https://cdn.test/avatars/u10/1700000000000-0123456789abcdef01234567.png';
      const { service, r2 } = setup({ avatarUrl: near });
      await service.deleteAccount('u1', SELF('old@example.com'));
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('a refused delete (email mismatch) never touches storage', async () => {
      const { service, r2 } = setup({ avatarUrl: URL });
      await expect(
        service.deleteAccount('u1', SELF('other@x.com')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });
  });
});

describe('AccountDeletionService seat decrements inside the transaction', () => {
  /**
   * Two concurrent deletes of people who share workspaces lock usage rows
   * in whatever order each UPDATE ... RETURNING happened to yield: A takes
   * W1 then W2 while B takes W2 then W1 = deadlock. A fixed order cannot.
   */
  it('decrements in sorted workspace order, whatever order RETURNING gave', async () => {
    const { service, usage } = setup({});
    // A fake tx: every chain is awaitable and resolves to the next queued
    // result; the locked user row first, then no owned workspaces.
    const queue: unknown[][] = [
      [{ email: 'old@example.com', deletedAt: null, avatarUrl: null }],
      [],
    ];
    const chain = (): Record<string, unknown> => {
      const result = queue.shift() ?? [];
      const b: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'for', 'set', 'values']) {
        b[m] = () => b;
      }
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej);
      return b;
    };
    const tx = {
      select: jest.fn(chain),
      update: jest.fn(chain),
      insert: jest.fn(chain),
      delete: jest.fn(chain),
    };
    const internals = service as unknown as {
      removeMemberships: jest.Mock;
      deletePersonalRows: jest.Mock;
      deleteInTransaction: (
        tx: unknown,
        userId: string,
        input: unknown,
      ) => Promise<{ seatWorkspaces: string[] }>;
    };
    internals.removeMemberships = jest.fn().mockResolvedValue([
      { workspaceId: 'w-c', role: 'MEMBER', status: 'ACCEPTED' },
      { workspaceId: 'w-a', role: 'ADMIN', status: 'ACCEPTED' },
      { workspaceId: 'w-b', role: 'MEMBER', status: 'ACCEPTED' },
      { workspaceId: 'w-a', role: 'MEMBER', status: 'ACCEPTED' },
      { workspaceId: 'w-g', role: 'GUEST', status: 'ACCEPTED' },
    ]);
    internals.deletePersonalRows = jest.fn().mockResolvedValue(undefined);

    const outcome = await internals.deleteInTransaction(tx, 'u1', {
      actor: 'self',
      actorId: 'u1',
    });

    const order = (usage.decrementMemberCount.mock.calls as string[][]).map(
      (c) => c[0],
    );
    expect(order).toEqual(['w-a', 'w-b', 'w-c']);
    expect(outcome.seatWorkspaces).toEqual(['w-a', 'w-b', 'w-c']);
  });
});
