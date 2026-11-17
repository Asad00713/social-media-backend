import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersController } from '../users/users.controller';
import { NotificationPauseController } from './notification-pause.controller';
import type { NotificationPauseService } from './notification-pause.service';

const CALLER = { userId: 'user-1', email: 'a@example.test' };

function makeController() {
  const pause = {
    get: jest.fn().mockResolvedValue({ pausedUntil: null }),
    set: jest
      .fn()
      .mockResolvedValue({ pausedUntil: '2026-12-01T00:00:00.000Z' }),
  };
  return {
    controller: new NotificationPauseController(
      pause as unknown as NotificationPauseService,
    ),
    pause,
  };
}

function routesOf(ctor: { prototype: Record<string, any> }) {
  const base = Reflect.getMetadata('path', ctor) as string;
  return Object.getOwnPropertyNames(ctor.prototype)
    .filter((n) => Reflect.hasMetadata('method', ctor.prototype[n]))
    .map((n) => ({
      method: Reflect.getMetadata('method', ctor.prototype[n]) as RequestMethod,
      path: `/${base}/${Reflect.getMetadata('path', ctor.prototype[n]) as string}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, ''),
    }));
}

describe('NotificationPauseController', () => {
  it('is behind the JWT guard at class level', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      NotificationPauseController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('serves users/me/notifications/pause with GET and PUT', () => {
    expect(
      routesOf(NotificationPauseController).map((r) => [r.method, r.path]),
    ).toEqual([
      [RequestMethod.GET, '/users/me/notifications/pause'],
      [RequestMethod.PUT, '/users/me/notifications/pause'],
    ]);
  });

  it('no UsersController route can swallow the pause routes (users/:id)', () => {
    const target = '/users/me/notifications/pause'.split('/');
    for (const own of routesOf(NotificationPauseController)) {
      for (const other of routesOf(UsersController)) {
        if (other.method !== own.method) continue;
        const parts = other.path.split('/');
        const matches =
          parts.length === target.length &&
          parts.every((p, i) => p.startsWith(':') || p === target[i]);
        expect(matches).toBe(false);
      }
    }
  });

  it('GET reads the caller own row', async () => {
    const { controller, pause } = makeController();
    expect(await controller.get(CALLER)).toEqual({ pausedUntil: null });
    expect(pause.get).toHaveBeenCalledWith('user-1');
  });

  it('PUT turns the ISO string into a Date for the caller own row', async () => {
    const { controller, pause } = makeController();
    await controller.set(CALLER, { until: '2026-12-01T00:00:00.000Z' });
    expect(pause.set).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-12-01T00:00:00.000Z'),
    );
  });

  it('PUT passes null through, which clears the pause', async () => {
    const { controller, pause } = makeController();
    await controller.set(CALLER, { until: null });
    expect(pause.set).toHaveBeenCalledWith('user-1', null);
  });
});
