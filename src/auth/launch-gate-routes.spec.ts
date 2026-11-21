import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { SKIP_LAUNCH_GATE } from './decorators/skip-launch-gate.decorator';
import { GoogleAuthController } from './google/google-auth.controller';
import { TwoFactorAuthController } from './two-factor/two-factor-auth.controller';
import { SessionsController } from './session/sessions.controller';
import { WorkspaceMembersController } from '../workspace-members/workspace-members.controller';

/**
 * The launch gate blocks non-allowlisted users from the whole app. That is the
 * point — but a user who has just signed up is not yet allowlisted and still
 * has to be able to finish creating their account. Those routes opt out with
 * `@SkipLaunchGate()`.
 *
 * This is asserted on the controller's real decorator metadata rather than on
 * the guard, because the guard cannot have this bug: it honours whatever
 * metadata it is handed. The bug is a route that forgot to ask.
 *
 * It has happened. Removing the guard's onboarding pass-through (a live bypass
 * that let random signups connect channels and publish mid-onboarding) moved
 * the exemption to per-route opt-outs, and `verify-otp` and
 * `resend-verification` were missed — so every non-allowlisted signup could
 * create an account and then never verify it. This test is what makes the
 * omission fail loudly instead of reaching a real user.
 */
describe('launch gate route exemptions', () => {
  const reflector = new Reflector();

  const skips = (method: keyof AuthController) =>
    reflector.get<boolean>(
      SKIP_LAUNCH_GATE,
      AuthController.prototype[method] as unknown as () => unknown,
    ) === true;

  describe('pre-launch account setup stays reachable', () => {
    // Everything a signed-up but non-allowlisted user must still be able to
    // do: prove who they are, verify their address, and finish onboarding.
    it.each([
      ['getProfile', 'the frontend reads isAllowlisted from /auth/me'],
      ['verifyOtp', 'verifying the email is the whole point of signing up'],
      ['resendVerification', 'the first code can genuinely go missing'],
      ['verifyEmail', 'the legacy link-based flow lands here'],
      ['completeOnboarding', 'account setup finishes before the app locks'],
      ['logout', 'a blocked user must still be able to leave'],
    ] as const)('%s skips the gate — %s', (method: keyof AuthController) => {
      expect(skips(method)).toBe(true);
    });
  });

  describe('password reset stays reachable', () => {
    // A locked-out user with a forgotten password is still a user. These are
    // unauthenticated, so the guard passes them through today anyway — the
    // decorator makes that intentional rather than incidental, and keeps them
    // working if a token is ever attached.
    it.each(['forgotPassword', 'resetPassword'] as const)(
      '%s skips the gate',
      (method) => {
        expect(skips(method)).toBe(true);
      },
    );
  });

  describe('the app itself stays gated', () => {
    // The exemption list must not grow to cover routes that are the actual
    // product. Login is deliberately gated: a non-allowlisted user gets the
    // Under-development screen rather than a session into a locked app.
    it.each(['login', 'register'] as const)(
      '%s does NOT skip the gate',
      (m) => {
        expect(skips(m)).toBe(false);
      },
    );
  });

  describe('Google sign-in stays reachable', () => {
    it('the whole Google controller skips the gate', () => {
      expect(
        reflector.get<boolean>(SKIP_LAUNCH_GATE, GoogleAuthController),
      ).toBe(true);
    });
  });

  describe('two-step sign-in stays reachable', () => {
    it('verify skips the gate - a sign-in started on /auth/login must be able to finish', () => {
      // Unauthenticated, so the guard passes it today anyway; the decorator
      // keeps it working if a token is ever attached. Login stays gated.
      expect(
        reflector.get<boolean>(
          SKIP_LAUNCH_GATE,
          Reflect.get(
            TwoFactorAuthController.prototype,
            'verify',
          ) as () => unknown,
        ),
      ).toBe(true);
    });
  });

  describe('the sessions page stays reachable', () => {
    // Securing an account must work before launch access.
    it.each(['list', 'revoke', 'revokeOthers'] as const)(
      'SessionsController.%s skips the gate (class-level)',
      (method) => {
        expect(
          reflector.getAllAndOverride<boolean>(SKIP_LAUNCH_GATE, [
            SessionsController.prototype[method] as unknown as () => unknown,
            SessionsController,
          ]),
        ).toBe(true);
      },
    );
  });

  describe('invitations', () => {
    it('accepting an invitation skips the gate', () => {
      // With the allowlist on, a non-allowlisted invitee got a 403 here and
      // the invite was never accepted. The gate still blocks the rest of the
      // app for them until launch; it just no longer eats the invitation.
      expect(
        reflector.get<boolean>(
          SKIP_LAUNCH_GATE,
          WorkspaceMembersController.prototype
            .acceptInvitation as unknown as () => unknown,
        ),
      ).toBe(true);
    });
  });
});
