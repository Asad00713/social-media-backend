import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsEventsGateway } from './analytics-events.gateway';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { AnalyticsEventEmitter } from './analytics-event-emitter.service';
import { SecurityCoreModule } from '../auth/security-core.module';

@Global() // expose emitter app-wide without per-module import
@Module({
  imports: [
    // SessionCheck for the socket handshake (a revoked session cannot open one).
    SecurityCoreModule,
    ConfigModule,
    WorkspaceRoleModule,
    // No default secret: the gateway passes JWT_ACCESS_SECRET to verifyAsync
    // itself. A module-wide default would let any provider here sign a
    // session-shaped token without naming the secret (guard spec).
    JwtModule.register({}),
  ],
  providers: [AnalyticsEventsGateway, AnalyticsEventEmitter],
  exports: [AnalyticsEventEmitter],
})
export class RealtimeModule {}
