import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import type { SubscriptionService } from '../billing/services/subscription.service';
import type { UsageService } from '../billing/services/usage.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * The checks that run BEFORE anything is written, with a fake db: each
 * `select` chain resolves to the next queued result. What the transaction
 * writes is proven against Postgres in account-deletion.db.spec.ts.
 */
function setup(opts: {
  user?: { email: string; deletedAt: Date | null } | null;
  owned?: { id: string; name: string }[];
  cancel?: () => Promise<unknown>;
  leftWorkspaces?: string[] | null;
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
    transaction: jest
      .fn()
      .mockResolvedValue(
        opts.leftWorkspaces === undefined ? [] : opts.leftWorkspaces,
      ),
  };
  const subscriptions = {
    cancelForAccount: jest.fn(opts.cancel ?? (() => Promise.resolve('none'))),
  };
  const usage = {
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AccountDeletionService(
    db as unknown as DbType,
    subscriptions as unknown as SubscriptionService,
    usage as unknown as UsageService,
  );
  return { service, db, subscriptions, usage };
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
    });
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

  it('after commit, each workspace left gets its member count decremented; a failure does not fail the delete', async () => {
    const { service, usage } = setup({ leftWorkspaces: ['w1', 'w2'] });
    usage.decrementMemberCount.mockRejectedValueOnce(new Error('no usage row'));

    await expect(
      service.deleteAccount('u1', SELF('old@example.com')),
    ).resolves.toBeUndefined();
    expect(usage.decrementMemberCount).toHaveBeenCalledWith('w1', 'u1', 'u1');
    expect(usage.decrementMemberCount).toHaveBeenCalledWith('w2', 'u1', 'u1');
  });

  it('a concurrent delete that won (transaction returns null) decrements nothing', async () => {
    const { service, usage } = setup({ leftWorkspaces: null });
    await service.deleteAccount('u1', SELF('old@example.com'));
    expect(usage.decrementMemberCount).not.toHaveBeenCalled();
  });
});
