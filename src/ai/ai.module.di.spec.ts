/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- jest mocks are untyped */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AiController } from './ai.controller';
import { AiModule } from './ai.module';
import { InboxAiService } from './inbox-ai.service';
import { DRIZZLE } from '../drizzle/drizzle.module';

// D4: DI proof without Redis. AiModule has no queue providers; only the DB
// pool is replaced by a stub.
describe('AiModule wiring', () => {
  it('resolves the controller and InboxAiService with the DRIZZLE token', async () => {
    const db = {};
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AiModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .compile();
    expect(moduleRef.get(AiController)).toBeInstanceOf(AiController);
    const svc = moduleRef.get(InboxAiService);
    expect(svc).toBeInstanceOf(InboxAiService);
    expect((svc as any).db).toBe(db);
    await moduleRef.close();
  });
});
