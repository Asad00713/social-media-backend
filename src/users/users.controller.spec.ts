import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { CloudflareR2Service } from '../media/cloudflare-r2.service';
import type { AccountDeletionService } from './account-deletion.service';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

/**
 * These routes were unauthenticated before, with the target id taken from the
 * URL. The tests that matter are therefore about REFUSAL: proving a caller
 * cannot reach a record that is not theirs.
 */
const SELF = { userId: 'user-1', role: 'USER' };
const OTHER_ID = 'user-2';

function makeController() {
  const service = {
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 'user-1' }),
    update: jest.fn().mockResolvedValue({ id: 'user-1' }),
  };
  const accountDeletion = {
    deleteAccount: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new UsersController(
      service as unknown as UsersService,
      {} as CloudflareR2Service,
      accountDeletion as unknown as AccountDeletionService,
    ),
    service,
    accountDeletion,
  };
}

describe('UsersController authorization', () => {
  describe('another account', () => {
    it('refuses to read it', () => {
      const { controller, service } = makeController();

      expect(() => controller.findOne(OTHER_ID, SELF)).toThrow(
        ForbiddenException,
      );
      // The refusal must happen BEFORE the service is asked — otherwise the
      // record is already loaded and only the response is withheld.
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('refuses to change it', () => {
      const { controller, service } = makeController();

      expect(() =>
        controller.update(OTHER_ID, { name: 'Hacked' }, SELF),
      ).toThrow(ForbiddenException);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('does not reveal whether the account exists', () => {
      const { controller } = makeController();

      // Same wording for a real id and an invented one: a different message
      // would make this endpoint an id-discovery oracle.
      const forOther = () => void controller.findOne(OTHER_ID, SELF);
      const forNonsense = () => void controller.findOne('no-such-id', SELF);

      let a = '';
      let b = '';
      try {
        forOther();
      } catch (e) {
        a = (e as Error).message;
      }
      try {
        forNonsense();
      } catch (e) {
        b = (e as Error).message;
      }
      expect(a).toBe(b);
    });
  });

  describe('own account', () => {
    it('reads it', async () => {
      const { controller, service } = makeController();

      await controller.findOne(SELF.userId, SELF);

      expect(service.findOne).toHaveBeenCalledWith(SELF.userId);
    });

    it('changes it', async () => {
      const { controller, service } = makeController();

      await controller.update(SELF.userId, { name: 'New' }, SELF);

      expect(service.update).toHaveBeenCalledWith(SELF.userId, {
        name: 'New',
      });
    });
  });

  describe('super admin', () => {
    const admin = { userId: 'admin-1', role: 'SUPER_ADMIN' };

    it('reaches any account, since support work requires it', async () => {
      const { controller, service } = makeController();

      await controller.findOne(OTHER_ID, admin);

      expect(service.findOne).toHaveBeenCalledWith(OTHER_ID);
    });
  });
});

describe('DELETE /users/:id (super admin only)', () => {
  it('is behind SuperAdminGuard, so not even the account holder reaches it (they use DELETE /users/me)', () => {
    const handler: object = Reflect.get(
      UsersController.prototype,
      'remove',
    ) as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      SuperAdminGuard,
    );
  });

  it('soft-deletes through AccountDeletionService as super_admin, never a hard delete', async () => {
    const { controller, accountDeletion } = makeController();
    const admin = { userId: 'admin-1', role: 'SUPER_ADMIN' };

    await controller.remove(OTHER_ID, admin);

    expect(accountDeletion.deleteAccount).toHaveBeenCalledWith(OTHER_ID, {
      actor: 'super_admin',
      actorId: 'admin-1',
    });
  });
});
