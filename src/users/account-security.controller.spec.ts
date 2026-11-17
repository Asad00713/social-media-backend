import {
  RequestMethod,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthService } from '../auth/auth.service';
import { AccountSecurityController } from './account-security.controller';
import type { AccountSecurityService } from './account-security.service';
import type { EmailChangeService } from './email-change.service';

describe('AccountSecurityController.changePassword', () => {
  function setup(refusal?: Error) {
    const calls: string[] = [];
    const security = {
      changePassword: jest.fn(() => {
        calls.push('change');
        return refusal ? Promise.reject(refusal) : Promise.resolve();
      }),
    };
    const auth = {
      generateAccessToken: jest.fn(() => {
        calls.push('access');
        return Promise.resolve('access-token');
      }),
      generateRefreshToken: jest.fn(() => {
        calls.push('refresh');
        return Promise.resolve('refresh-token');
      }),
    };
    const response = { cookie: jest.fn() };
    const controller = new AccountSecurityController(
      security as unknown as AccountSecurityService,
      auth as unknown as AuthService,
      {} as EmailChangeService,
    );
    return { controller, security, auth, response, calls };
  }

  const caller = { userId: 'u1', email: 'a@b.co' };
  const dto = { currentPassword: 'OldPass123', newPassword: 'NewPass456' };

  it('changes the password first, then returns a fresh access token and sets the refresh cookie', async () => {
    const { controller, security, response, calls } = setup();

    const result = await controller.changePassword(
      caller,
      dto,
      '39.48.12.201',
      'UA',
      response as unknown as Response,
    );

    expect(result).toEqual({ accessToken: 'access-token' });
    expect(security.changePassword).toHaveBeenCalledWith('u1', dto, {
      ip: '39.48.12.201',
      userAgent: 'UA',
    });
    // Minted after the revocation, so the new pair is not refused.
    expect(calls).toEqual(['change', 'access', 'refresh']);
    expect(response.cookie).toHaveBeenCalledWith(
      'refreshToken',
      'refresh-token',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('mints nothing when the change is refused', async () => {
    const refused = new Error('CURRENT_PASSWORD_INCORRECT');
    const { controller, auth, response } = setup(refused);

    await expect(
      controller.changePassword(
        caller,
        dto,
        undefined,
        undefined,
        response as unknown as Response,
      ),
    ).rejects.toBe(refused);
    expect(auth.generateAccessToken).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

type ThrottledRoute =
  | 'changePassword'
  | 'requestEmailChange'
  | 'disconnectGoogle';

describe('per-user throttles on POST /users/me/password, /email-change and /google/disconnect', () => {
  let storage: ThrottlerStorageService;
  let guard: ThrottlerGuard;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    // The app-wide default (100 a minute); the route's own limit must win.
    guard = new ThrottlerGuard(
      [{ ttl: 60_000, limit: 100 }],
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });
  // The in-memory storage holds one expiry timer per key.
  afterEach(() => storage.onApplicationShutdown());

  function attempt(
    userId: string,
    ip: string,
    route: ThrottledRoute = 'changePassword',
  ): Promise<boolean> {
    return run({ user: { userId, email: 'a@b.co' }, ip, headers: {} }, route);
  }

  function run(
    req: Record<string, unknown>,
    route: ThrottledRoute = 'changePassword',
  ): Promise<boolean> {
    const res = { header: jest.fn() };
    const context = {
      // The handler reference is only read for its @Throttle metadata.
      getHandler: () => AccountSecurityController.prototype[route],
      getClass: () => AccountSecurityController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  }

  it('counts per user: five tries from two IPs use up the hour, a sixth from a new IP is refused', async () => {
    for (const ip of ['1.1.1.1', '2.2.2.2', '1.1.1.1', '2.2.2.2', '1.1.1.1']) {
      await expect(attempt('u1', ip)).resolves.toBe(true);
    }
    await expect(attempt('u1', '3.3.3.3')).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    // Someone else behind the same IP is not affected.
    await expect(attempt('u2', '1.1.1.1')).resolves.toBe(true);
  });

  it('the email change counts per user too: two IPs share one 5-an-hour budget', async () => {
    for (const ip of ['1.1.1.1', '2.2.2.2', '1.1.1.1', '2.2.2.2', '1.1.1.1']) {
      await expect(attempt('u1', ip, 'requestEmailChange')).resolves.toBe(true);
    }
    await expect(
      attempt('u1', '3.3.3.3', 'requestEmailChange'),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await expect(attempt('u2', '1.1.1.1', 'requestEmailChange')).resolves.toBe(
      true,
    );
    // Its own bucket: the password route is untouched.
    await expect(attempt('u1', '1.1.1.1')).resolves.toBe(true);
  });

  it('google/disconnect counts per user: five tries from two IPs use up the hour, a sixth is refused', async () => {
    for (const ip of ['1.1.1.1', '2.2.2.2', '1.1.1.1', '2.2.2.2', '1.1.1.1']) {
      await expect(attempt('u1', ip, 'disconnectGoogle')).resolves.toBe(true);
    }
    await expect(
      attempt('u1', '3.3.3.3', 'disconnectGoogle'),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await expect(attempt('u2', '1.1.1.1', 'disconnectGoogle')).resolves.toBe(
      true,
    );
    // Its own bucket ('google:' + id): the password and email routes are untouched.
    await expect(attempt('u1', '1.1.1.1')).resolves.toBe(true);
    await expect(attempt('u1', '1.1.1.1', 'requestEmailChange')).resolves.toBe(
      true,
    );
  });

  it.each([
    'changePassword',
    'requestEmailChange',
    'disconnectGoogle',
  ] as const)(
    '%s without a signed-in user is a 401, not a TypeError',
    async (route) => {
      await expect(
        run({ ip: '1.1.1.1', headers: {} }, route),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        run({ user: {}, ip: '1.1.1.1', headers: {} }, route),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});

describe('AccountSecurityController.disconnectGoogle', () => {
  const caller = { userId: 'u1', email: 'a@b.co' };
  const user = { id: 'u1', hasGoogle: false };

  function setup(refusal?: Error) {
    const security = {
      disconnectGoogle: jest.fn(() =>
        refusal ? Promise.reject(refusal) : Promise.resolve(user),
      ),
    };
    const controller = new AccountSecurityController(
      security as unknown as AccountSecurityService,
      {} as AuthService,
      {} as EmailChangeService,
    );
    return { controller, security };
  }

  it('hands the caller id, the password and the request context to the service, and returns the user', async () => {
    const { controller, security } = setup();

    await expect(
      controller.disconnectGoogle(
        caller,
        { currentPassword: 'OldPass123' },
        '39.48.12.201',
        'UA',
      ),
    ).resolves.toBe(user);

    expect(security.disconnectGoogle).toHaveBeenCalledWith('u1', 'OldPass123', {
      ip: '39.48.12.201',
      userAgent: 'UA',
    });
  });

  it('missing ip and user agent become null', async () => {
    const { controller, security } = setup();
    await controller.disconnectGoogle(
      caller,
      { currentPassword: 'OldPass123' },
      undefined,
      undefined,
    );
    expect(security.disconnectGoogle).toHaveBeenCalledWith('u1', 'OldPass123', {
      ip: null,
      userAgent: null,
    });
  });

  it('a refusal reaches the caller untouched', async () => {
    const refused = new Error('WRONG_PASSWORD');
    const { controller } = setup(refused);
    await expect(
      controller.disconnectGoogle(
        caller,
        { currentPassword: 'x' },
        '1.1.1.1',
        'UA',
      ),
    ).rejects.toBe(refused);
  });

  it('is POST users/me/google/disconnect behind JwtAuthGuard (class) and ThrottlerGuard (route), answering 200', () => {
    const handler = AccountSecurityController.prototype.disconnectGoogle;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'google/disconnect',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
    expect(Reflect.getMetadata('__guards__', handler)).toContain(
      ThrottlerGuard,
    );
    const classGuards = Reflect.getMetadata(
      '__guards__',
      AccountSecurityController,
    ) as { name: string }[];
    expect(classGuards.map((g) => g.name)).toContain('JwtAuthGuard');
  });
});
