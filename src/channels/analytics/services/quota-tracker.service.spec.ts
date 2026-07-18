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
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    clear() {
      this.store.clear();
    },
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

  it('keeps subsystem spend in separate buckets', async () => {
    await service.tryConsume('youtube', 100, 'inbox');
    const analytics = await service.tryConsume('youtube', 100, 'analytics');
    expect(analytics.allowed).toBe(true);
    // Analytics' 5000 allowance is untouched by the inbox's 100 units.
    expect(analytics.remaining).toBe(4900);
  });

  // The whole point of the split: a background poll must never be able to
  // make the user's publish fail.
  it('still allows publishing when the inbox allowance is exhausted', async () => {
    // Spend up to the inbox threshold (95% of 3000 = 2850), then confirm the
    // next inbox call is refused — genuinely exhausted, not merely refused.
    const spend = await service.tryConsume('youtube', 2800, 'inbox');
    expect(spend.allowed).toBe(true);
    const refused = await service.tryConsume('youtube', 100, 'inbox');
    expect(refused.allowed).toBe(false);

    const publish = await service.tryConsume('youtube', 100, 'publishing');
    expect(publish.allowed).toBe(true);
  });

  it('falls back to the whole platform budget when no subsystem is given', async () => {
    const result = await service.tryConsume('youtube', 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9900);
  });

  // YouTube's quota resets at midnight Pacific, not UTC. This instant is
  // 2026-07-18T04:00:00Z, which is 2026-07-17T21:00:00-07:00 in Los Angeles
  // (PDT) — same instant, different calendar date in each timezone. The day
  // bucket must follow Pacific, or a UTC-derived key would roll over 7-8
  // hours before YouTube's own quota day actually resets.
  it('buckets the day key by Pacific time, not UTC', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-18T04:00:00Z'));
    try {
      await service.tryConsume('youtube', 10, 'publishing');
      const keys = [...fakeRedis.store.keys()];
      expect(keys).toContain('quota:youtube:publishing:2026-07-17');
      expect(keys).not.toContain('quota:youtube:publishing:2026-07-18');
    } finally {
      jest.useRealTimers();
    }
  });
});
