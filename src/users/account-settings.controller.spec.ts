import 'reflect-metadata';
import {
  BadRequestException,
  RequestMethod,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { Response } from 'express';
import { SKIP_LAUNCH_GATE } from '../auth/decorators/skip-launch-gate.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  AccountSettingsController,
  deleteAccountTracker,
} from './account-settings.controller';
import type { AccountDeletionService } from './account-deletion.service';
import { DEFAULT_PREFERENCES } from './preferences/user-preferences';
import type { UserPreferencesService } from './preferences/user-preferences.service';
import type { MyWorkspacesService } from './my-workspaces.service';
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
  const myWorkspaces = {
    list: jest.fn().mockResolvedValue({ workspaces: [] }),
  };
  const accountDeletion = {
    deleteAccount: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new AccountSettingsController(
      preferences as unknown as UserPreferencesService,
      myWorkspaces as unknown as MyWorkspacesService,
      accountDeletion as unknown as AccountDeletionService,
    ),
    preferences,
    myWorkspaces,
    accountDeletion,
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

  it('GET workspaces lists the caller own workspaces, never an id from the URL', async () => {
    const { controller, myWorkspaces } = makeController();
    expect(await controller.getWorkspaces(CALLER)).toEqual({ workspaces: [] });
    expect(myWorkspaces.list).toHaveBeenCalledWith('user-1');
  });

  it('GET workspaces is routed at users/me/workspaces', () => {
    const handler: object = Reflect.get(
      AccountSettingsController.prototype,
      'getWorkspaces',
    ) as object;
    expect(Reflect.getMetadata('path', handler)).toBe('workspaces');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.GET);
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

describe('DELETE /users/me', () => {
  function response() {
    return { clearCookie: jest.fn() };
  }

  it('deletes the caller own account as `self`, never an id from the URL, and clears the refresh cookie', async () => {
    const { controller, accountDeletion } = makeController();
    const res = response();

    await expect(
      controller.deleteAccount(
        CALLER,
        { confirmEmail: ' A@Example.test ' },
        res as unknown as Response,
      ),
    ).resolves.toBeUndefined();

    expect(accountDeletion.deleteAccount).toHaveBeenCalledWith('user-1', {
      confirmEmail: ' A@Example.test ',
      actor: 'self',
      actorId: 'user-1',
    });
    // The same name and options as /auth/logout, or the browser keeps it.
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    });
  });

  it('a refused delete leaves the cookie alone (the person is still signed in)', async () => {
    const { controller, accountDeletion } = makeController();
    const refused = new BadRequestException({ code: 'EMAIL_MISMATCH' });
    accountDeletion.deleteAccount.mockRejectedValueOnce(refused);
    const res = response();

    await expect(
      controller.deleteAccount(
        CALLER,
        { confirmEmail: 'other@x.com' },
        res as unknown as Response,
      ),
    ).rejects.toBe(refused);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('is DELETE users/me answering 204, behind JwtAuthGuard (class) and ThrottlerGuard (route)', () => {
    const handler: object = Reflect.get(
      AccountSettingsController.prototype,
      'deleteAccount',
    ) as object;
    expect(Reflect.getMetadata('path', handler)).toBe('/');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(204);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      ThrottlerGuard,
    );
  });

  it('DELETE users/me and GET users/me/workspaces skip the launch gate; preferences do not', () => {
    const meta = (name: string): unknown =>
      Reflect.getMetadata(
        SKIP_LAUNCH_GATE,
        Reflect.get(AccountSettingsController.prototype, name) as object,
      );
    expect(meta('deleteAccount')).toBe(true);
    expect(meta('getWorkspaces')).toBe(true);
    expect(meta('getPreferences')).toBeUndefined();
    // Not on the class: every other users/me route stays gated.
    expect(
      Reflect.getMetadata(SKIP_LAUNCH_GATE, AccountSettingsController),
    ).toBeUndefined();
  });

  it('throttles on the user id, prefixed delete:', () => {
    expect(deleteAccountTracker({ user: { userId: 'u9' } })).toBe('delete:u9');
    expect(() => deleteAccountTracker({})).toThrow(UnauthorizedException);
  });

  describe('3 an hour per user', () => {
    let storage: ThrottlerStorageService;
    let guard: ThrottlerGuard;

    beforeEach(async () => {
      storage = new ThrottlerStorageService();
      guard = new ThrottlerGuard(
        [{ ttl: 60_000, limit: 100 }],
        storage,
        new Reflector(),
      );
      await guard.onModuleInit();
    });
    afterEach(() => storage.onApplicationShutdown());

    function attempt(userId: string, ip: string): Promise<boolean> {
      const req = { user: { userId }, ip, headers: {} };
      const res = { header: jest.fn() };
      const context = {
        // Only read for its @Throttle metadata, never called.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        getHandler: () => AccountSettingsController.prototype.deleteAccount,
        getClass: () => AccountSettingsController,
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
      } as unknown as ExecutionContext;
      return guard.canActivate(context);
    }

    it('a fourth try in the hour is refused, from any IP; another user is unaffected', async () => {
      for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
        await expect(attempt('u1', ip)).resolves.toBe(true);
      }
      await expect(attempt('u1', '4.4.4.4')).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      await expect(attempt('u2', '1.1.1.1')).resolves.toBe(true);
    });
  });
});
