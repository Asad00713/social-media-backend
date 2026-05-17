import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { QuotaTrackerService } from './quota-tracker.service';

describe('QuotaTrackerService', () => {
  let service: QuotaTrackerService;

  const fakeRedis = {
    store: new Map<string, number>(),
    async get(key: string) {
      return this.store.has(key) ? String(this.store.get(key)) : null;
    },
    async incrby(key: string, by: number) {
      const next = (this.store.get(key) ?? 0) + by;
      this.store.set(key, next);
      return next;
    },
    async expire(_key: string, _seconds: number) { return 1; },
    clear() { this.store.clear(); },
  };

  beforeEach(async () => {
    fakeRedis.clear();
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        QuotaTrackerService,
        { provide: 'REDIS_CLIENT', useValue: fakeRedis },
      ],
    }).compile();

    service = module.get<QuotaTrackerService>(QuotaTrackerService);
  });

  it('allows calls when platform has no quota budget (null dailyQuotaBudget)', async () => {
    // bluesky has dailyQuotaBudget: null in placeholder
    const result = await service.tryConsume('bluesky', 1);
    expect(result.allowed).toBe(true);
  });

  it('allows calls when platform is not in capabilities registry', async () => {
    // Use a platform string that won't match — service should fail-open
    const result = await service.tryConsume('google_drive' as any, 1);
    expect(result.allowed).toBe(true);
  });
});
