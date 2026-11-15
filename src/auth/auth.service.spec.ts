import * as bcrypt from 'bcrypt';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { hash } from '../common/utils/encryption.util';
import { AppLinks } from '../email/links/app-links';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { ResetPasswordProps } from '../email/templates/security/reset-password';
import type { VerifyEmailProps } from '../email/templates/security/verify-email';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

/** The first argument of a mock's first call, typed (mock.calls is any[][]). */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown[][])[0][0] as T;
}

/**
 * AuthService takes ten collaborators. Each test overrides only the ones it
 * exercises; the rest are inert stubs that fail loudly if reached.
 */
export function makeAuthService(
  overrides: {
    db?: unknown;
    usersService?: Record<string, jest.Mock>;
    outbox?: Record<string, jest.Mock>;
  } = {},
) {
  const db = overrides.db ?? { query: { users: { findFirst: jest.fn() } } };
  const usersService = overrides.usersService ?? {};
  const outbox = overrides.outbox ?? {
    sendNow: jest.fn().mockResolvedValue({ success: true }),
  };
  const links = new AppLinks({
    get: (key: string) =>
      key === 'FRONTEND_URL' ? 'https://app.test' : undefined,
  } as never);
  const accountSecurity = {
    sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    db as never,
    usersService as never,
    { sign: jest.fn().mockReturnValue('signed') } as never,
    { get: jest.fn().mockReturnValue('secret') } as never,
    outbox as never,
    { emailVerified: jest.fn() } as never,
    { verifyChallengeToken: jest.fn() } as never,
    { record: jest.fn(), recordSync: jest.fn() } as never,
    links,
    accountSecurity as never,
  );
  return { service, db, usersService, outbox, accountSecurity };
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
  it('claims an attempt, then verifies a correct code', async () => {
    const { service, usersService } = otpService(pendingUser());
    await service.verifyEmailWithOtp('u1', CODE);
    expect(usersService.incrementVerificationAttempts).toHaveBeenCalledWith(
      'u1',
      hash(CODE),
      5,
    );
    expect(usersService.verifyEmail).toHaveBeenCalledWith('u1');
  });

  it('accepts the correct code on the fifth claimed attempt', async () => {
    const { service, usersService } = otpService(pendingUser(), 5);
    await service.verifyEmailWithOtp('u1', CODE);
    expect(usersService.verifyEmail).toHaveBeenCalledWith('u1');
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
    expect(usersService.clearEmailVerificationToken).toHaveBeenCalledWith(
      'u1',
      hash(CODE),
    );
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
    // The guarded increment matched nothing: the count is already at 5.
    const { service, usersService } = otpService(
      pendingUser({ emailVerificationAttempts: 5 }),
      null,
    );
    const body = await codeOf(service.verifyEmailWithOtp('u1', CODE));
    expect(body.code).toBe('CODE_LOCKED');
    expect(usersService.verifyEmail).not.toHaveBeenCalled();
    expect(usersService.clearEmailVerificationToken).toHaveBeenCalledWith(
      'u1',
      hash(CODE),
    );
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
    const { service, outbox } = makeAuthService({
      usersService: {
        findByEmail: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'a@b.co',
          isEmailVerified: false,
          emailVerificationTokenExpiresAt: new Date(issuedAt + 10 * 60_000),
        }),
      },
    });

    const failure = service.resendVerificationEmail('a@b.co');
    await expect(failure).rejects.toBeInstanceOf(HttpException);
    await expect(failure).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    const error = (await failure.catch((e: unknown) => e)) as HttpException;
    const body = error.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('CODE_COOLDOWN');
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(39);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(41);
    expect(outbox.sendNow).not.toHaveBeenCalled();
  });
});

describe('AuthService A1 / A2 / A5 mail', () => {
  const USER = { id: 'u1', email: 'a@b.co', name: 'A' };
  afterEach(() => jest.restoreAllMocks());

  function registering(sendResult: { success: boolean; error?: string }) {
    const usersService = {
      create: jest.fn().mockResolvedValue(USER),
      setEmailVerificationToken: jest.fn().mockResolvedValue(undefined),
    };
    const outbox = { sendNow: jest.fn().mockResolvedValue(sendResult) };
    return { ...makeAuthService({ usersService, outbox }), usersService };
  }

  const dto = { email: 'a@b.co', name: 'A', password: 'Secret123' };

  it('register sends A1 through sendNow with the verify key and still reports a send failure', async () => {
    const { service, outbox, usersService } = registering({ success: true });
    const ok = await service.register(dto);
    expect(ok.message).toMatch(/check your email/);

    const [, storedHash, expiresAt] = usersService.setEmailVerificationToken
      .mock.calls[0] as [string, string, Date];
    const sent = firstArg<EnqueueEmail<VerifyEmailProps>>(outbox.sendNow);
    expect(sent.template.id).toBe('verify-email');
    expect(sent.template.footer).toBe('plain');
    expect(sent.to).toEqual({ email: 'a@b.co', userId: 'u1' });
    expect(sent.workspaceId).toBeNull();
    expect(sent.idempotencyKey).toBe(`verify.u1.${expiresAt.getTime()}`);
    expect(sent.props.code).toMatch(/^\d{6}$/);
    expect(sent.props.email).toBe('a@b.co');
    expect(hash(sent.props.code)).toBe(storedHash);

    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const failed = registering({ success: false, error: 'Resend down' });
    const res = await failed.service.register(dto);
    expect(res.accessToken).toBe('signed');
    expect(res.message).toMatch(/could not send the verification code/);
  });

  it('forgotPassword sends A2 through sendNow with the reset key and the frontend link', async () => {
    const usersService = {
      findByEmail: jest.fn().mockResolvedValue({
        ...USER,
        passwordResetTokenExpiresAt: null,
      }),
      setPasswordResetToken: jest.fn().mockResolvedValue(undefined),
    };
    const { service, outbox } = makeAuthService({ usersService });

    await service.forgotPassword('a@b.co');

    const [, storedHash, expiresAt] = usersService.setPasswordResetToken.mock
      .calls[0] as [string, string, Date];
    const sent = firstArg<EnqueueEmail<ResetPasswordProps>>(outbox.sendNow);
    expect(sent.template.id).toBe('reset-password');
    expect(sent.idempotencyKey).toBe(`reset.u1.${expiresAt.getTime()}`);
    expect(sent.props.email).toBe('a@b.co');
    const token = new URL(sent.props.resetUrl).searchParams.get('token');
    expect(sent.props.resetUrl).toBe(
      `https://app.test/reset-password?token=${token}`,
    );
    expect(hash(token!)).toBe(storedHash);
  });

  it('resetPassword revokes sessions and enqueues password-changed with via "reset"', async () => {
    const usersService = {
      findByPasswordResetToken: jest.fn().mockResolvedValue({
        ...USER,
        passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
      }),
      resetPassword: jest.fn().mockResolvedValue(undefined),
    };
    const { service, accountSecurity } = makeAuthService({ usersService });
    const ctx = { ip: '39.48.12.201', userAgent: 'UA' };

    await service.resetPassword('raw', 'Secret123', ctx);

    // UsersService.resetPassword stamps sessions_revoked_at in the same UPDATE
    // as the new hash (users.service.spec).
    expect(usersService.resetPassword).toHaveBeenCalledWith('u1', 'Secret123');
    expect(accountSecurity.sendPasswordChanged).toHaveBeenCalledWith(
      'u1',
      ctx,
      'reset',
    );
  });
});
