import { ForbiddenException } from '@nestjs/common';
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
    remove: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new UsersController(service as unknown as UsersService),
    service,
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

    it('refuses to delete it', () => {
      const { controller, service } = makeController();

      expect(() => controller.remove(OTHER_ID, SELF)).toThrow(
        ForbiddenException,
      );
      expect(service.remove).not.toHaveBeenCalled();
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

    it('deletes it', async () => {
      const { controller, service } = makeController();

      await controller.remove(SELF.userId, SELF);

      expect(service.remove).toHaveBeenCalledWith(SELF.userId);
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
