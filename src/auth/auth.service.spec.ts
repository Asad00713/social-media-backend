import * as bcrypt from 'bcrypt';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { hash } from '../common/utils/encryption.util';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * AuthService takes eight collaborators. Each test overrides only the ones it
 * exercises; the rest are inert stubs that fail loudly if reached.
 */
export function makeAuthService(
  overrides: {
    db?: unknown;
    usersService?: Record<string, jest.Mock>;
    emailService?: Record<string, jest.Mock>;
  } = {},
) {
  const db = overrides.db ?? { query: { users: { findFirst: jest.fn() } } };
  const usersService = overrides.usersService ?? {};
  const emailService = overrides.emailService ?? {
    sendVerificationEmail: jest.fn().mockResolvedValue({ success: true }),
  };
  const service = new AuthService(
    db as never,
    usersService as never,
    { sign: jest.fn().mockReturnValue('signed') } as never,
    { get: jest.fn().mockReturnValue('secret') } as never,
    emailService as never,
    { emailVerified: jest.fn(), passwordChanged: jest.fn() } as never,
    { verifyChallengeToken: jest.fn() } as never,
    { record: jest.fn(), recordSync: jest.fn() } as never,
  );
  return { service, db, usersService, emailService };
}

describe('AuthService.validateUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null for a Google-only account without asking bcrypt', async () => {
    // bcrypt.compare(plain, null) throws, which would turn a wrong-method
    // sign-in into a 500 instead of "Invalid credentials".
    const { service } = makeAuthService({
      usersService: {
        findByEmail: jest
          .fn()
          .mockResolvedValue({ id: 'u1', email: 'a@b.co', password: null }),
      },
    });

    await expect(
      service.validateUser('a@b.co', 'whatever'),
    ).resolves.toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('still checks the hash for a password account', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const user = { id: 'u1', email: 'a@b.co', password: 'hash' };
    const { service } = makeAuthService({
      usersService: { findByEmail: jest.fn().mockResolvedValue(user) },
    });

    await expect(service.validateUser('a@b.co', 'pw')).resolves.toBe(user);
    expect(bcrypt.compare).toHaveBeenCalledWith('pw', 'hash');
  });
});

const CODE = '123456';

function pendingUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@b.co',
    isEmailVerified: false,
    emailVerificationToken: hash(CODE),
    emailVerificationTokenExpiresAt: new Date(Date.now() + 5 * 60_000),
    emailVerificationAttempts: 0,
    ...over,
  };
}

function otpService(user: unknown, increment: number | null = 1) {
  const findFirst = jest.fn().mockResolvedValue(user);
  const usersService = {
    verifyEmail: jest.fn(),
    incrementVerificationAttempts: jest.fn().mockResolvedValue(increment),
    clearEmailVerificationToken: jest.fn(),
  };
  const built = makeAuthService({
    db: { query: { users: { findFirst } } },
    usersService,
  });
  return { ...built, usersService };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a BadRequestException');
}

describe('AuthService.verifyEmailWithOtp attempt limit', () => {
  it('verifies a correct code without counting an attempt', async () => {
    const { service, usersService } = otpService(pendingUser());
    await service.verifyEmailWithOtp('u1', CODE);
    expect(usersService.verifyEmail).toHaveBeenCalledWith('u1');
    expect(usersService.incrementVerificationAttempts).not.toHaveBeenCalled();
  });

  it('answers CODE_INVALID with attemptsLeft after a wrong guess', async () => {
    const { service } = otpService(pendingUser(), 2);
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body).toMatchObject({ code: 'CODE_INVALID', attemptsLeft: 3 });
  });

  it('locks and clears the code on the fifth wrong guess', async () => {
    const { service, usersService } = otpService(pendingUser(), 5);
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body.code).toBe('CODE_LOCKED');
    expect(usersService.clearEmailVerificationToken).toHaveBeenCalledWith('u1');
  });

  it('locks when a parallel request already spent the last attempt', async () => {
    // incrementVerificationAttempts returns null when the guarded UPDATE
    // matched nothing — the count was already at the ceiling.
    const { service } = otpService(
      pendingUser({ emailVerificationAttempts: 4 }),
      null,
    );
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body.code).toBe('CODE_LOCKED');
  });

  it('refuses even a correct code once the ceiling is reached', async () => {
    const { service, usersService } = otpService(
      pendingUser({ emailVerificationAttempts: 5 }),
    );
    const body = await codeOf(service.verifyEmailWithOtp('u1', CODE));
    expect(body.code).toBe('CODE_LOCKED');
    expect(usersService.verifyEmail).not.toHaveBeenCalled();
  });

  it.each([
    [
      'expired',
      { emailVerificationTokenExpiresAt: new Date(Date.now() - 1000) },
    ],
    [
      'missing',
      { emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
    ],
  ])('answers CODE_EXPIRED when the code is %s', async (_label, over) => {
    const { service } = otpService(pendingUser(over));
    const body = await codeOf(service.verifyEmailWithOtp('u1', CODE));
    expect(body.code).toBe('CODE_EXPIRED');
  });
});

describe('AuthService.resendVerificationEmail cooldown', () => {
  it('answers 429 CODE_COOLDOWN with the seconds left', async () => {
    // Issued 20s ago → 10-minute expiry is 9m40s away → 40s of cooldown left.
    const issuedAt = Date.now() - 20_000;
    const { service } = makeAuthService({
      usersService: {
        findByEmail: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'a@b.co',
          isEmailVerified: false,
          emailVerificationTokenExpiresAt: new Date(issuedAt + 10 * 60_000),
        }),
      },
    });

    try {
      await service.resendVerificationEmail('a@b.co');
      throw new Error('expected a 429');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      const body = (e as HttpException).getResponse() as Record<
        string,
        unknown
      >;
      expect(body.code).toBe('CODE_COOLDOWN');
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(39);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(41);
    }
  });
});
