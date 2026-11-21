import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from 'src/users/users.module';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { EmailModule } from '../email/email.module';
import { AdminChallengeService } from './admin-challenge.service';
import { AllowlistGuard } from './guards/allowlist.guard';
import { GeoipService } from './services/geoip.service';
import { LoginActivityService } from './services/login-activity.service';
import { GoogleOAuthClient } from './google/google-oauth.client';
import { GoogleAuthService } from './google/google-auth.service';
import { GoogleAuthController } from './google/google-auth.controller';
import { AccountSecurityController } from '../users/account-security.controller';
import { KnownDevicesService } from './devices/known-devices.service';
import { WelcomeEmailService } from './welcome-email.service';
import { EmailSecurityController } from '../email/public/email-security.controller';
import { SecurityActionsService } from '../email/public/security-actions.service';
import { SecurityCoreModule } from './security-core.module';
import { SessionIssuer } from './session/session-issuer';
import { TwoFactorNotices } from './two-factor/two-factor-notices.service';
import { MfaChallengeService } from './two-factor/mfa-challenge.service';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({}),
    EmailModule,
    SecurityCoreModule,
  ],
  providers: [
    AuthService,
    AdminChallengeService,
    GeoipService,
    LoginActivityService,
    GoogleOAuthClient,
    GoogleAuthService,
    KnownDevicesService,
    // The only session minter (see session-issuer.guard.spec.ts).
    SessionIssuer,
    // Two-step sign-in security emails.
    TwoFactorNotices,
    MfaChallengeService,
    WelcomeEmailService,
    JwtStrategy,
    JwtRefreshStrategy,
    // Global launch-gate enforcement (see AllowlistGuard). Registered here
    // rather than in AppModule: an APP_GUARD is global regardless of which
    // module declares it, but its dependencies (JwtService, UsersService)
    // resolve against the DECLARING module's injector. AuthModule already
    // has JwtModule and imports UsersModule, so the guard's deps resolve
    // cleanly here without needing to re-import them into AppModule.
    { provide: APP_GUARD, useClass: AllowlistGuard },
    // The email security links (EmailSecurityController) secure an account
    // through AuthService and AccountSecurityService, so they live here too.
    SecurityActionsService,
  ],
  // AccountSecurityController (POST /users/me/password) mints tokens through
  // SessionIssuer, so it is registered here: UsersModule cannot import AuthModule
  // back without a module cycle.
  controllers: [
    AuthController,
    GoogleAuthController,
    AccountSecurityController,
    EmailSecurityController,
  ],
})
export class AuthModule {}
