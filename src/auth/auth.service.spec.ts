import * as bcrypt from 'bcrypt';
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

    await expect(service.validateUser('a@b.co', 'whatever')).resolves.toBeNull();
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
