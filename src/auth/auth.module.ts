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

@Module({
  imports: [UsersModule, PassportModule, JwtModule.register({}), EmailModule],
  providers: [
    AuthService,
    AdminChallengeService,
    JwtStrategy,
    JwtRefreshStrategy,
    // Global launch-gate enforcement (see AllowlistGuard). Registered here
    // rather than in AppModule: an APP_GUARD is global regardless of which
    // module declares it, but its dependencies (JwtService, UsersService)
    // resolve against the DECLARING module's injector. AuthModule already
    // has JwtModule and imports UsersModule, so the guard's deps resolve
    // cleanly here without needing to re-import them into AppModule.
    { provide: APP_GUARD, useClass: AllowlistGuard },
  ],
  controllers: [AuthController],
})
export class AuthModule {}
