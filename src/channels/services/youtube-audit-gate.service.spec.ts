import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { YoutubeAuditGateService } from './youtube-audit-gate.service';

const fakeRedis = {
  store: new Map<string, number>(),
  async incr(key: string) {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  },
  async decr(key: string) {
    const next = (this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
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
      YoutubeAuditGateService,
      { provide: 'REDIS_CLIENT', useValue: fakeRedis },
    ],
  }).compile();
  return mod.get(YoutubeAuditGateService);
}

describe('YoutubeAuditGateService', () => {
  beforeEach(() => {
    fakeRedis.clear();
    delete process.env.YOUTUBE_APP_AUDITED;
  });

  it('allows an upload under both caps', async () => {
    const svc = await build();
    await expect(svc.reserveUpload(1)).resolves.toBeUndefined();
  });

  it('enforces the 10/day per-channel cap', async () => {
    const svc = await build();
    for (let i = 0; i < 10; i++) await svc.reserveUpload(1);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
  });

  it('enforces the 50/day app-wide cap while unaudited', async () => {
    const svc = await build();
    // Spread across channels so the per-channel cap never fires first.
    for (let i = 0; i < 50; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).rejects.toThrow(/pre-audit/i);
  });

  it('lifts the app-wide cap once audited', async () => {
    process.env.YOUTUBE_APP_AUDITED = 'true';
    const svc = await build();
    for (let i = 0; i < 60; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).resolves.toBeUndefined();
  });

  // A missing env var must fail SAFE — unset means unaudited, not audited.
  it('treats a missing YOUTUBE_APP_AUDITED as unaudited', async () => {
    const svc = await build();
    for (let i = 0; i < 50; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).rejects.toBeInstanceOf(HttpException);
  });

  // A rejected reservation must not leave the counter incremented, or the
  // cap would ratchet down on every rejected attempt.
  it('does not consume a slot when it rejects', async () => {
    const svc = await build();
    for (let i = 0; i < 10; i++) await svc.reserveUpload(1);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
    }).format(new Date());
    expect(fakeRedis.store.get(`youtube:uploads:channel:1:${day}`)).toBe(10);
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
      const svc = await build();
      await svc.reserveUpload(1);
      const keys = [...fakeRedis.store.keys()];
      expect(keys).toContain('youtube:uploads:channel:1:2026-07-17');
      expect(keys).not.toContain('youtube:uploads:channel:1:2026-07-18');
    } finally {
      jest.useRealTimers();
    }
  });
});
