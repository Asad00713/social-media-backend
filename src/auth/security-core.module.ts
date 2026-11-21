import { Module } from '@nestjs/common';
import { SessionCheck } from './session/session-check';
import { SessionStore } from './session/session-store';
import { SecondFactorService } from './two-factor/second-factor.service';

/**
 * The database-only security building blocks: session rows and the cached
 * session check, and the second-factor checks (SecondFactorService, whose
 * constructor resolves MFA_CODE_PEPPER: every process that builds this
 * module, web and worker, refuses to boot without one outside dev/test).
 *
 * Kept free of every Nest dependency beyond the global DrizzleModule and
 * config, so UsersModule, AdminModule and both socket gateways can import it
 * without importing AuthModule — which imports UsersModule, so that would be
 * a module cycle.
 */
@Module({
  providers: [SessionStore, SessionCheck, SecondFactorService],
  exports: [SessionStore, SessionCheck, SecondFactorService],
})
export class SecurityCoreModule {}
