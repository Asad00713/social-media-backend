import type { Response } from 'express';
import type { AuthService } from '../auth/auth.service';
import { AccountSecurityController } from './account-security.controller';
import type { AccountSecurityService } from './account-security.service';

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
