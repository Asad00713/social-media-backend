import 'reflect-metadata';
import { HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { SKIP_LAUNCH_GATE } from '../decorators/skip-launch-gate.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { JwtUser } from '../strategies/jwt.strategy';
import { SessionsController } from './sessions.controller';

const ME = '11111111-1111-4111-8111-111111111111';
const CURRENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLDEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const row = (id: string, lastUsedAt: string, over: object = {}) => ({
  id,
  userId: ME,
  deviceHash: 'd'.repeat(64),
  label: 'Chrome on Windows',
  deviceType: 'desktop',
  ip: '203.0.113.9',
  country: 'Pakistan',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  lastUsedAt: new Date(lastUsedAt),
  expiresAt: new Date('2026-12-30T00:00:00Z'),
  revokedAt: null,
  ...over,
});

function caller(sid: string | null): JwtUser {
  return { userId: ME, email: 'a@b.co', role: 'USER', sid, iat: 1 };
}

function build() {
  // listLive answers newest use first, as the store does.
  const rows = [
    row(OTHER, '2026-11-21T10:00:00Z', { deviceType: 'mobile' }),
    row(CURRENT, '2026-11-21T09:00:00Z'),
    row(OLDEST, '2026-11-01T09:00:00Z', { country: null }),
  ];
  const revoked = new Set<string>();
  const sessions = {
    listLive: jest.fn().mockResolvedValue(rows),
    // Like the store: only the caller's own live row.
    revoke: jest.fn((userId: string, sid: string) => {
      const ok =
        userId === ME && rows.some((r) => r.id === sid) && !revoked.has(sid);
      if (ok) revoked.add(sid);
      return Promise.resolve(ok);
    }),
    revokeOthers: jest.fn((userId: string, keep: string | null) => {
      const n = rows.filter((r) => r.id !== keep && !revoked.has(r.id));
      n.forEach((r) => revoked.add(r.id));
      return Promise.resolve(n.length);
    }),
  };
  return {
    controller: new SessionsController(sessions as never),
    sessions,
    revoked,
  };
}

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return { status: e.getStatus(), body: e.getResponse() };
    }
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('GET /users/me/sessions', () => {
  it('lists live sessions, current first, then newest use, with isCurrent and no ip/deviceHash', async () => {
    const b = build();
    const { sessions } = await b.controller.list(caller(CURRENT));
    expect(b.sessions.listLive).toHaveBeenCalledWith(ME);
    expect(sessions.map((s) => s.id)).toEqual([CURRENT, OTHER, OLDEST]);
    expect(sessions.map((s) => s.isCurrent)).toEqual([true, false, false]);
    expect(sessions[1]).toEqual({
      id: OTHER,
      label: 'Chrome on Windows',
      deviceType: 'mobile',
      country: 'Pakistan',
      lastUsedAt: '2026-11-21T10:00:00.000Z',
      isCurrent: false,
    });
    expect(sessions[2].country).toBeNull();
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual(
        [
          'country',
          'deviceType',
          'id',
          'isCurrent',
          'label',
          'lastUsedAt',
        ].sort(),
      );
    }
  });

  it('a sid-less caller sees every session with isCurrent false, newest first', async () => {
    const b = build();
    const { sessions } = await b.controller.list(caller(null));
    expect(sessions.map((s) => s.id)).toEqual([OTHER, CURRENT, OLDEST]);
    expect(sessions.every((s) => !s.isCurrent)).toBe(true);
  });
});

describe('DELETE /users/me/sessions/:id', () => {
  it('revokes another of my sessions (204)', async () => {
    const b = build();
    await expect(
      b.controller.revoke(caller(CURRENT), OTHER),
    ).resolves.toBeUndefined();
    expect(b.sessions.revoke).toHaveBeenCalledWith(ME, OTHER);
    expect(b.revoked.has(OTHER)).toBe(true);
  });

  it('the current session → 400 SESSION_IS_CURRENT, nothing revoked', async () => {
    const b = build();
    const err = await errorOf(b.controller.revoke(caller(CURRENT), CURRENT));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'SESSION_IS_CURRENT' });
    expect(b.sessions.revoke).not.toHaveBeenCalled();
  });

  it("another user's session id → 404 and nothing revoked", async () => {
    const b = build();
    const stranger = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await expect(
      b.controller.revoke(caller(CURRENT), stranger),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The store is asked with MY user id, so another user's row cannot match.
    expect(b.sessions.revoke).toHaveBeenCalledWith(ME, stranger);
    expect(b.revoked.size).toBe(0);
  });

  it('an already revoked session → 404', async () => {
    const b = build();
    await b.controller.revoke(caller(CURRENT), OTHER);
    await expect(
      b.controller.revoke(caller(CURRENT), OTHER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('POST /users/me/sessions/revoke-others', () => {
  it("returns the count and keeps the caller's sid", async () => {
    const b = build();
    await expect(b.controller.revokeOthers(caller(CURRENT))).resolves.toEqual({
      revoked: 2,
    });
    expect(b.sessions.revokeOthers).toHaveBeenCalledWith(ME, CURRENT);
    expect(b.revoked.has(CURRENT)).toBe(false);
    expect(b.revoked.has(OTHER)).toBe(true);
    expect(b.revoked.has(OLDEST)).toBe(true);
  });
});

describe('SessionsController metadata', () => {
  const reflector = new Reflector();

  it('every route needs a signed-in user and skips the launch gate', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SessionsController) as unknown[],
    ).toContain(JwtAuthGuard);
    expect(reflector.get<boolean>(SKIP_LAUNCH_GATE, SessionsController)).toBe(
      true,
    );
  });

  it('DELETE answers 204 and revoke-others 200', () => {
    const proto = SessionsController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.revoke)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.revokeOthers)).toBe(
      200,
    );
  });
});
