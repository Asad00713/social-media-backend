import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountSettingsController } from './account-settings.controller';
import { DEFAULT_PREFERENCES } from './preferences/user-preferences';
import type { UserPreferencesService } from './preferences/user-preferences.service';
import { UsersController } from './users.controller';
import { UsersModule } from './users.module';

const CALLER = { userId: 'user-1', email: 'a@example.test' };

function makeController() {
  const preferences = {
    get: jest.fn().mockResolvedValue(DEFAULT_PREFERENCES),
    update: jest.fn().mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
    }),
  };
  return {
    controller: new AccountSettingsController(
      preferences as unknown as UserPreferencesService,
    ),
    preferences,
  };
}

describe('AccountSettingsController', () => {
  it('is behind the JWT guard at class level', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AccountSettingsController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('serves users/me', () => {
    expect(Reflect.getMetadata('path', AccountSettingsController)).toBe(
      'users/me',
    );
  });

  it('GET preferences reads the caller own row, never an id from the URL', async () => {
    const { controller, preferences } = makeController();
    expect(await controller.getPreferences(CALLER)).toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(preferences.get).toHaveBeenCalledWith('user-1');
  });

  it('PATCH preferences writes the caller own row', async () => {
    const { controller, preferences } = makeController();
    const result = await controller.updatePreferences(CALLER, {
      theme: 'dark',
    });
    expect(result.theme).toBe('dark');
    expect(preferences.update).toHaveBeenCalledWith('user-1', {
      theme: 'dark',
    });
  });

  it('is registered before UsersController, so users/me never reaches users/:id', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      UsersModule,
    ) as unknown[];
    expect(controllers.indexOf(AccountSettingsController)).toBe(0);
    expect(controllers.indexOf(AccountSettingsController)).toBeLessThan(
      controllers.indexOf(UsersController),
    );
  });
});
