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
import { AccountDeletionService } from './account-deletion.service';

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
  const service = new AccountDeletionService(
    db as unknown as DbType,
    subscriptions as unknown as SubscriptionService,
    usage as unknown as UsageService,
    r2 as unknown as CloudflareR2Service,
  );
  return { service, db, subscriptions, usage, r2 };
}

const SELF = (confirmEmail?: string) => ({
  confirmEmail,
  actor: 'self' as const,
  actorId: 'u1',
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
