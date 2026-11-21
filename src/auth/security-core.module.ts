import { Module } from '@nestjs/common';
import { SessionCheck } from './session/session-check';
import { SessionStore } from './session/session-store';

/**
 * The database-only security building blocks: session rows and the cached
 * session check (and, from the two-step tasks, the second-factor checks).
 *
 * Kept free of every Nest dependency beyond the global DrizzleModule and
 * config, so UsersModule, AdminModule and both socket gateways can import it
 * without importing AuthModule — which imports UsersModule, so that would be
 * a module cycle.
 */
@Module({
  providers: [SessionStore, SessionCheck],
  exports: [SessionStore, SessionCheck],
})
export class SecurityCoreModule {}
