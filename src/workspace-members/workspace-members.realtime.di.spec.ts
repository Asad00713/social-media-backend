import { readFileSync } from 'fs';
import { join } from 'path';
import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { UsageService } from 'src/billing/services/usage.service';
import { EmailOutboxService } from 'src/email/queue/email-outbox.service';
import { AppLinks } from 'src/email/links/app-links';
import { NotificationEmitterService } from 'src/notifications/notification-emitter.service';
import { NotifyService } from 'src/notifications/notify.service';
import { RecipientsService } from 'src/notifications/recipients.service';
import { UsersService } from 'src/users/users.service';
import { AnalyticsEventEmitter } from 'src/realtime/analytics-event-emitter.service';
import { AnalyticsEventsGateway } from 'src/realtime/analytics-events.gateway';
import { WorkspaceRoleService } from './workspace-role.service';
import { WorkspaceMembersService } from './workspace-members.service';

// The service is constructed by hand in its other specs, which cannot prove
// the container injects the emitter: a removed member would then stay in the
// live room with every spec green. This resolves the real class from a
// container where the emitter comes from a @Global module, as in
// RealtimeModule (whose source this also reads, so the two cannot drift).
const gateway = { removeUserFromWorkspace: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: AnalyticsEventsGateway, useValue: gateway },
    AnalyticsEventEmitter,
  ],
  exports: [AnalyticsEventEmitter],
})
class GlobalRealtimeStub {}

describe('WorkspaceMembersService wiring', () => {
  it('is handed the real AnalyticsEventEmitter by the container, and a removal reaches the gateway', async () => {
    const stub = (token: string | symbol | Type): Provider => ({
      provide: token,
      useValue: {},
    });
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalRealtimeStub],
      providers: [
        WorkspaceMembersService,
        stub(DRIZZLE),
        stub(UsageService),
        stub(EmailOutboxService),
        stub(UsersService),
        stub(WorkspaceRoleService),
        stub(NotifyService),
        stub(NotificationEmitterService),
        stub(RecipientsService),
        stub(AppLinks),
      ],
    }).compile();

    const service = moduleRef.get(WorkspaceMembersService);
    const injected = (service as unknown as { realtime: unknown }).realtime;
    expect(injected).toBeInstanceOf(AnalyticsEventEmitter);

    (injected as AnalyticsEventEmitter).removeUserFromWorkspace('u1', 'ws1');
    expect(gateway.removeUserFromWorkspace).toHaveBeenCalledWith('u1', 'ws1');
    await moduleRef.close();
  });

  it('RealtimeModule is global and exports the emitter, so WorkspaceMembersModule needs no import', () => {
    // Source-level, like plan-feature.guard.di.spec.ts: booting RealtimeModule
    // needs the session store and a database.
    const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
    const realtime = read('../realtime/realtime.module.ts');
    expect(realtime).toContain('@Global()');
    expect(realtime).toMatch(/exports:\s*\[AnalyticsEventEmitter\]/);
    // AppModule imports it, so the global provider exists in the running app.
    expect(read('../app.module.ts')).toContain('RealtimeModule,');
  });
});
