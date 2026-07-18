import { Test } from '@nestjs/testing';
import { YoutubeInboxBudgetService } from './youtube-inbox-budget.service';

const MIN = 60_000;
const DAY = 24 * 60 * 60_000;
const NOW = 1_000 * DAY;

const fakeRedis = {
  store: new Map<string, string>(),
  async get(key: string) {
    return this.store.get(key) ?? null;
  },
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  },
  async mget(keys: string[]) {
    return keys.map((k) => this.store.get(k) ?? null);
  },
  async incrby(key: string, by: number) {
    const next = Number(this.store.get(key) ?? '0') + by;
    this.store.set(key, String(next));
    return next;
  },
  async expire() {
    return 1;
  },
  clear() {
    this.store.clear();
  },
};

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeInboxBudgetService,
      { provide: 'REDIS_CLIENT', useValue: fakeRedis },
    ],
  }).compile();
  return mod.get(YoutubeInboxBudgetService);
}

/** N videos all published `ageMs` ago. */
function videos(n: number, ageMs: number, prefix = 'v') {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `${prefix}${i}`,
    publishedAtMs: NOW - ageMs,
  }));
}

describe('YoutubeInboxBudgetService', () => {
  beforeEach(() => {
    fakeRedis.clear();
    delete process.env.YOUTUBE_INBOX_DAILY_UNITS;
  });

  it('selects every never-polled hot video when the budget is ample', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(5, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(5);
    expect(sel.deferred).toBe(0);
  });

  it('excludes cold videos entirely', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(3, 60 * DAY), NOW);
    expect(sel.due).toHaveLength(0);
    // Cold is not "deferred" — it is out of scope, not starved of budget.
    expect(sel.deferred).toBe(0);
  });

  it('excludes videos polled more recently than their tier interval', async () => {
    const svc = await build();
    await svc.markPolled(1, 'v0', NOW - 1 * MIN);
    const sel = await svc.selectDue(1, videos(1, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(0);
  });

  // The budget is the whole point: without it, cost scales with channel count
  // and any "safe" interval becomes unsafe at 10 channels.
  it('serves hot before warm when the budget cannot cover both', async () => {
    process.env.YOUTUBE_INBOX_DAILY_UNITS = '3';
    const svc = await build();
    const candidates = [
      ...videos(2, 4 * DAY, 'warm'), // warm
      ...videos(3, 1 * MIN, 'hot'), // hot
    ];
    const sel = await svc.selectDue(1, candidates, NOW);

    expect(sel.due).toHaveLength(3);
    expect(sel.due.every((c) => c.videoId.startsWith('hot'))).toBe(true);
    expect(sel.deferred).toBe(2);
    expect(sel.deferredByTier.warm).toBe(2);
  });

  it('spends the allowance across calls, not per call', async () => {
    process.env.YOUTUBE_INBOX_DAILY_UNITS = '4';
    const svc = await build();

    const first = await svc.selectDue(1, videos(3, 1 * MIN, 'a'), NOW);
    expect(first.due).toHaveLength(3);

    // 3 of 4 units are already spent today — only 1 more fits.
    const second = await svc.selectDue(2, videos(3, 1 * MIN, 'b'), NOW);
    expect(second.due).toHaveLength(1);
    expect(second.deferred).toBe(2);
  });

  it('defaults the daily allowance to 3000 units', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(3200, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(3000);
    expect(sel.deferred).toBe(200);
  });
});
