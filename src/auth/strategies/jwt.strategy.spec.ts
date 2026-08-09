import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy suspension', () => {
  function make(userOverrides: Record<string, unknown>) {
    const usersService = {
      findOneWithSuspension: jest.fn().mockResolvedValue(userOverrides),
    };
    const config = { get: jest.fn().mockReturnValue('test-secret') };
    return new JwtStrategy(config as never, usersService as never);
  }

  it('throws a structured ACCOUNT_SUSPENDED 401 when the user is inactive', async () => {
    const strategy = make({
      id: 'u1', email: 'a@b.com', role: 'USER',
      isActive: false, suspendedReason: 'policy_violation',
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED', reason: 'policy_violation' },
    });
  });

  it('passes an active user through', async () => {
    const strategy = make({
      id: 'u1', email: 'a@b.com', role: 'USER', isActive: true, suspendedReason: null,
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).resolves.toMatchObject({ userId: 'u1', role: 'USER' });
  });
});
