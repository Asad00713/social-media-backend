import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ClientIpThrottlerGuard } from '../../common/guards/client-ip-throttler.guard';
import { TWO_FACTOR_VERIFY_THROTTLE } from '../auth-throttle';
import { SKIP_LAUNCH_GATE } from '../decorators/skip-launch-gate.decorator';
import { VerifyTwoFactorDto } from './dto/verify-two-factor.dto';
import {
  mfaChallengeExpired,
  mfaCodeAmbiguous,
  mfaCodeInvalid,
  mfaLocked,
} from './mfa-errors';
import { MAX_CHALLENGE_ATTEMPTS } from './mfa-challenge.service';
import { TwoFactorAuthController } from './two-factor-auth.controller';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CID = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';
const DEVICE_HASH = 'a'.repeat(64);
const PUBLIC_USER = { id: USER_ID, email: 'a@b.co', twoFactorEnabled: true };

/**
 * A fake challenge store with the real semantics the controller relies on:
 * a burnt or consumed challenge no longer opens, five failures burn it.
 */
function fakeChallenges() {
  const state = { attempts: 0, consumed: false };
  return {
    state,
    open: jest.fn(() => {
      if (state.consumed) return Promise.reject(mfaChallengeExpired());
      return Promise.resolve({
        cid: CID,
        userId: USER_ID,
        deviceHash: DEVICE_HASH,
      });
    }),
    reserveAttempt: jest.fn(() => {
      if (state.consumed || state.attempts >= MAX_CHALLENGE_ATTEMPTS) {
        return Promise.reject(mfaChallengeExpired());
      }
      state.attempts += 1;
      return Promise.resolve(MAX_CHALLENGE_ATTEMPTS - state.attempts);
    }),
    release: jest.fn(() => {
      state.attempts = Math.max(0, state.attempts - 1);
      return Promise.resolve();
    }),
    burn: jest.fn(() => {
      state.consumed = true;
      return Promise.resolve();
    }),
    consume: jest.fn(() => {
      if (state.consumed) return Promise.resolve(false);
      state.consumed = true;
      return Promise.resolve(true);
    }),
  };
}

type CheckAnswer =
  | { ok: { method: 'totp' | 'backup'; backupCodesRemaining: number } }
  | { error: HttpException };

function build(
  answer: CheckAnswer = { ok: { method: 'totp', backupCodesRemaining: 10 } },
) {
  const challenges = fakeChallenges();
  const secondFactor = {
    check: jest.fn(() =>
      'error' in answer
        ? Promise.reject(answer.error)
        : Promise.resolve(answer.ok),
    ),
  };
  const issuer = {
    // Like the real issuer: the refresh cookie is set only when it mints.
    issue: jest.fn((_u: string, _req: unknown, res: { cookie: jest.Mock }) => {
      res.cookie('refreshToken', 'refresh');
      return Promise.resolve({
        kind: 'session',
        accessToken: 'access',
        sid: SID,
      });
    }),
  };
  const notices = {
    failed: jest.fn().mockResolvedValue(undefined),
    backupCodeUsed: jest.fn().mockResolvedValue(undefined),
  };
  const users = { findOne: jest.fn().mockResolvedValue(PUBLIC_USER) };
  const controller = new TwoFactorAuthController(
    challenges as never,
    secondFactor as never,
    issuer as never,
    notices as never,
    users as never,
  );
  const res = { cookie: jest.fn() };
  const req = {
    cookies: {},
    headers: { 'user-agent': 'UA', 'x-real-ip': '203.0.113.9' },
  } as never;
  const verify = (body: Partial<VerifyTwoFactorDto> = { code: '123456' }) =>
    controller.verify(
      { challengeToken: 'challenge', ...body } as VerifyTwoFactorDto,
      req,
      res as never,
    );
  return {
    controller,
    challenges,
    secondFactor,
    issuer,
    notices,
    users,
    res,
    req,
    verify,
  };
}

async function errorOf(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        body: e.getResponse() as Record<string, unknown>,
      };
    }
    throw e;
  }
  throw new Error('expected a rejection');
}

const refreshCookieSet = (res: { cookie: jest.Mock }) =>
  res.cookie.mock.calls.some((call: unknown[]) => call[0] === 'refreshToken');

describe('POST /auth/2fa/verify', () => {
  it('right code → 200 {accessToken, user}, refresh cookie set, challenge consumed', async () => {
    const b = build();
    const result = await b.verify({ code: '123456' });

    expect(result).toEqual({ accessToken: 'access', user: PUBLIC_USER });
    expect(b.secondFactor.check).toHaveBeenCalledWith(USER_ID, {
      code: '123456',
      backupCode: undefined,
    });
    expect(b.challenges.consume).toHaveBeenCalledWith(CID);
    expect(b.challenges.state.consumed).toBe(true);
    expect(b.issuer.issue).toHaveBeenCalledWith(USER_ID, b.req, b.res, {
      via: 'two_factor',
      trustDeviceHash: DEVICE_HASH,
    });
    expect(refreshCookieSet(b.res)).toBe(true);
    expect(b.users.findOne).toHaveBeenCalledWith(USER_ID);
  });

  it('the challenge is consumed BEFORE the issuer mints', async () => {
    const b = build();
    await b.verify();
    expect(b.challenges.consume.mock.invocationCallOrder[0]).toBeLessThan(
      b.issuer.issue.mock.invocationCallOrder[0],
    );
  });

  it('the challenge attempt is reserved BEFORE the code is judged (review ruling 1)', async () => {
    const b = build();
    await b.verify();
    expect(
      b.challenges.reserveAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(b.secondFactor.check.mock.invocationCallOrder[0]);
  });

  it('ten parallel wrong codes on one challenge: at most five are judged', async () => {
    const b = build({ error: mfaCodeInvalid() });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => errorOf(b.verify())),
    );
    expect(b.secondFactor.check).toHaveBeenCalledTimes(MAX_CHALLENGE_ATTEMPTS);
    expect(answers.every((a) => a.status === 400)).toBe(true);
    expect(b.issuer.issue).not.toHaveBeenCalled();
  });

  it('a right fifth code still signs in (the fifth reservation does not burn)', async () => {
    const b = build();
    b.challenges.state.attempts = MAX_CHALLENGE_ATTEMPTS - 1;
    await expect(b.verify()).resolves.toMatchObject({ accessToken: 'access' });
  });

  it('a failing second-factor check gives the attempt back and is the answer', async () => {
    const b = build();
    b.secondFactor.check.mockRejectedValueOnce(new Error('db down'));
    await expect(b.verify()).rejects.toThrow('db down');
    expect(b.challenges.state.attempts).toBe(0);
    expect(b.issuer.issue).not.toHaveBeenCalled();
  });

  it('wrong code → 400 MFA_CODE_INVALID with attemptsLeft 4, no cookie, no token', async () => {
    const b = build({ error: mfaCodeInvalid() });
    const err = await errorOf(b.verify({ code: '000000' }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({
      code: 'MFA_CODE_INVALID',
      attemptsLeft: 4,
    });
    expect(b.challenges.reserveAttempt).toHaveBeenCalledWith(CID);
    expect(b.challenges.release).not.toHaveBeenCalled();
    expect(b.challenges.consume).not.toHaveBeenCalled();
    expect(b.issuer.issue).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('attemptsLeft counts down 4,3,2,1 and the 5th wrong code → 400 MFA_CHALLENGE_EXPIRED', async () => {
    const b = build({ error: mfaCodeInvalid() });
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push((await errorOf(b.verify())).body.attemptsLeft);
    }
    expect(seen).toEqual([4, 3, 2, 1]);
    const fifth = await errorOf(b.verify());
    expect(fifth.status).toBe(400);
    expect(fifth.body.code).toBe('MFA_CHALLENGE_EXPIRED');
    expect(b.challenges.burn).toHaveBeenCalledWith(CID);
    // And the challenge is gone: a sixth try cannot even open it.
    const sixth = await errorOf(b.verify());
    expect(sixth.body.code).toBe('MFA_CHALLENGE_EXPIRED');
    expect(b.issuer.issue).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('a consumed challenge (replayed request after success) → MFA_CHALLENGE_EXPIRED, no second session', async () => {
    const b = build();
    await b.verify();
    b.res.cookie.mockClear();
    const replay = await errorOf(b.verify());
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('MFA_CHALLENGE_EXPIRED');
    expect(b.issuer.issue).toHaveBeenCalledTimes(1);
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('two requests racing past open: only the one that wins consume mints', async () => {
    const b = build();
    b.challenges.consume
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const settled = await Promise.allSettled([b.verify(), b.verify()]);
    expect(settled.map((s) => s.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(b.issuer.issue).toHaveBeenCalledTimes(1);
  });

  it('locked user → 429 MFA_LOCKED with retryAfterSeconds, challenge attempts untouched', async () => {
    const b = build({ error: mfaLocked(840) });
    const err = await errorOf(b.verify());
    expect(err.status).toBe(429);
    expect(err.body).toMatchObject({
      code: 'MFA_LOCKED',
      retryAfterSeconds: 840,
    });
    // The attempt reserved for it is given back: the code was never judged.
    expect(b.challenges.release).toHaveBeenCalledWith(CID);
    expect(b.challenges.state.attempts).toBe(0);
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('both code and backupCode → 400 MFA_CODE_REQUIRED, no attempt counted', async () => {
    const b = build({ error: mfaCodeAmbiguous() });
    const err = await errorOf(
      b.verify({ code: '123456', backupCode: 'ABCD-EFGH' }),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({
      code: 'MFA_CODE_REQUIRED',
      message: 'Send a code or a backup code, not both.',
    });
    // Refused before anything is reserved or judged.
    expect(b.challenges.reserveAttempt).not.toHaveBeenCalled();
    expect(b.secondFactor.check).not.toHaveBeenCalled();
  });

  it('first wrong code sends two-step-failed once, keyed by the challenge', async () => {
    const b = build({ error: mfaCodeInvalid() });
    await errorOf(b.verify());
    await errorOf(b.verify());
    await errorOf(b.verify());
    expect(b.notices.failed).toHaveBeenCalledTimes(1);
    expect(b.notices.failed).toHaveBeenCalledWith(
      USER_ID,
      { ip: '203.0.113.9', userAgent: 'UA' },
      CID,
    );
  });

  it('a failing notice never changes the answer', async () => {
    const b = build({ error: mfaCodeInvalid() });
    b.notices.failed.mockRejectedValue(new Error('mail down'));
    const err = await errorOf(b.verify());
    expect(err.body.code).toBe('MFA_CODE_INVALID');
  });

  it('backup code success sends backup-code-used with the remaining count', async () => {
    const b = build({ ok: { method: 'backup', backupCodesRemaining: 7 } });
    await b.verify({ code: undefined, backupCode: 'abcd-efgh' });
    expect(b.secondFactor.check).toHaveBeenCalledWith(USER_ID, {
      code: undefined,
      backupCode: 'abcd-efgh',
    });
    expect(b.notices.backupCodeUsed).toHaveBeenCalledWith(
      USER_ID,
      { ip: '203.0.113.9', userAgent: 'UA' },
      7,
    );
  });

  it('a TOTP success sends no backup-code or failure email', async () => {
    const b = build();
    await b.verify();
    expect(b.notices.backupCodeUsed).not.toHaveBeenCalled();
    expect(b.notices.failed).not.toHaveBeenCalled();
  });

  it('never answers 401 for a bad code, a burnt challenge, a lock or an ambiguous body', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => build({ error: mfaCodeInvalid() }).verify(),
      () => build({ error: mfaLocked(60) }).verify(),
      () =>
        build({ error: mfaCodeAmbiguous() }).verify({
          code: '123456',
          backupCode: 'ABCD-EFGH',
        }),
      () => {
        const b = build();
        b.challenges.state.consumed = true;
        return b.verify();
      },
      async () => {
        const b = build({ error: mfaCodeInvalid() });
        for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i++) {
          await errorOf(b.verify());
        }
        return b.verify();
      },
    ];
    for (const run of cases) {
      const err = await errorOf(run());
      expect(err.status).not.toBe(401);
      expect([400, 429]).toContain(err.status);
    }
  });
});

describe('route metadata', () => {
  const handler = Reflect.get(
    TwoFactorAuthController.prototype,
    'verify',
  ) as object;

  it('buckets by the visitor IP (ClientIpThrottlerGuard) with 10 per 15 minutes', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toContain(ClientIpThrottlerGuard);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(
      15 * 60 * 1000,
    );
    expect(TWO_FACTOR_VERIFY_THROTTLE).toEqual({
      default: { limit: 10, ttl: 15 * 60 * 1000 },
    });
  });

  it('skips the launch gate (sign-in finishes before the app locks)', () => {
    expect(
      new Reflector().get<boolean>(SKIP_LAUNCH_GATE, handler as () => unknown),
    ).toBe(true);
  });
});

describe('VerifyTwoFactorDto', () => {
  const errors = (body: object) =>
    validateSync(plainToInstance(VerifyTwoFactorDto, body), {
      whitelist: true,
    }).map((e) => e.property);

  it('accepts a token with a 6-digit code or a backup code', () => {
    expect(errors({ challengeToken: 't', code: '123456' })).toEqual([]);
    expect(errors({ challengeToken: 't', backupCode: 'ABCD-EFGH' })).toEqual(
      [],
    );
    // Neither is the service's MFA_CODE_REQUIRED, not a DTO 400.
    expect(errors({ challengeToken: 't' })).toEqual([]);
  });

  it('refuses a non-6-digit code, a missing or huge token, an overlong backup code', () => {
    expect(errors({ challengeToken: 't', code: '12345' })).toContain('code');
    expect(errors({ challengeToken: 't', code: '12345a' })).toContain('code');
    expect(errors({ code: '123456' })).toContain('challengeToken');
    expect(errors({ challengeToken: 'x'.repeat(2049) })).toContain(
      'challengeToken',
    );
    expect(
      errors({ challengeToken: 't', backupCode: 'A'.repeat(33) }),
    ).toContain('backupCode');
  });
});
