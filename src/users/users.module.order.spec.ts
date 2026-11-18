import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { AccountSettingsController } from './account-settings.controller';
import { UsersController } from './users.controller';
import { UsersModule } from './users.module';

/**
 * Express matches routes in registration order, and Nest registers a
 * module's controllers in the order listed. `DELETE /users/:id` (super admin
 * only) would capture `DELETE /users/me` if UsersController came first: the
 * person would get a 403 instead of deleting their account.
 */
describe('UsersModule controller order', () => {
  it('lists AccountSettingsController before UsersController', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      UsersModule,
    ) as unknown[];
    const settings = controllers.indexOf(AccountSettingsController);
    const users = controllers.indexOf(UsersController);
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(users).toBeGreaterThanOrEqual(0);
    expect(settings).toBeLessThan(users);
  });

  it('the two routes really collide: DELETE users/me vs DELETE users/:id', () => {
    const me = Reflect.get(
      AccountSettingsController.prototype,
      'deleteAccount',
    ) as object;
    const byId = Reflect.get(UsersController.prototype, 'remove') as object;
    expect(Reflect.getMetadata('path', AccountSettingsController)).toBe(
      'users/me',
    );
    expect(Reflect.getMetadata('method', me)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata('path', UsersController)).toBe('users');
    expect(Reflect.getMetadata('path', byId)).toBe(':id');
    expect(Reflect.getMetadata('method', byId)).toBe(RequestMethod.DELETE);
  });
});
