import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  ACK_WINDOW_SECONDS,
  ACKS_PER_WINDOW_GLOBAL,
  ContactAckLimiter,
  type AckLimiterRedis,
} from './contact-ack-limiter';

/** What the Lua script does, in memory: INCR, and EXPIRE on the first hit. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const expiries = new Map<string, string>();
  const redis = {
    eval: jest.fn(
      (_script: string, _numKeys: number, key: string, ttl: string) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n === 1) expiries.set(key, ttl);
        return Promise.resolve(n);
      },
    ),
  };
  return { redis, counts, expiries };
}

describe('ContactAckLimiter', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('allows two acknowledgements an hour and refuses the third', async () => {
    const { redis } = fakeRedis();
    const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

    expect(await limiter.allow('ada@example.com')).toBe(true);
    expect(await limiter.allow('ada@example.com')).toBe(true);
    expect(await limiter.allow('ada@example.com')).toBe(false);
    expect(await limiter.allow('ada@example.com')).toBe(false);
  });

  it('counts one address per person, whatever its case or padding', async () => {
    const { redis } = fakeRedis();
    const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

    await limiter.allow('ada@example.com');
    await limiter.allow(' ADA@Example.com ');

    expect(await limiter.allow('Ada@EXAMPLE.com')).toBe(false);
    expect(await limiter.allow('grace@example.com')).toBe(true);
  });

  it('keys on a sha256 of the address and starts a one-hour window', async () => {
    const { redis, counts, expiries } = fakeRedis();
    const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

    await limiter.allow('Ada@Example.com');

    const digest = createHash('sha256').update('ada@example.com').digest('hex');
    expect([...counts.keys()]).toEqual([`contact-ack:${digest}`]);
    expect(expiries.get(`contact-ack:${digest}`)).toBe(
      String(ACK_WINDOW_SECONDS),
    );
    expect(ACK_WINDOW_SECONDS).toBe(3600);
    // No Redis argument carries the address itself.
    expect(JSON.stringify(redis.eval.mock.calls)).not.toContain('ada@');
  });

  it('fails closed when Redis errors, without logging the address', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

    await expect(limiter.allow('ada@example.com')).resolves.toBe(false);

    expect(logged.join('\n')).toContain('connection refused');
    expect(logged.join('\n')).not.toContain('ada@example.com');
  });

  it('fails closed when Redis hangs', async () => {
    jest.useFakeTimers();
    const redis = { eval: jest.fn(() => new Promise<never>(() => undefined)) };
    const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

    const result = limiter.allow('ada@example.com');
    await jest.advanceTimersByTimeAsync(2500);

    await expect(result).resolves.toBe(false);
  });

  describe('global budget', () => {
    it('allows 30 an hour across all addresses, refuses the 31st, and logs once per window', async () => {
      const { redis, counts, expiries } = fakeRedis();
      const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

      for (let i = 0; i < ACKS_PER_WINDOW_GLOBAL; i++) {
        expect(await limiter.allowGlobal()).toBe(true);
      }
      expect(await limiter.allowGlobal()).toBe(false);
      expect(await limiter.allowGlobal()).toBe(false);
      expect(await limiter.allowGlobal()).toBe(false);

      expect([...counts.keys()]).toEqual(['contact-ack-global']);
      expect(expiries.get('contact-ack-global')).toBe('3600');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('30 this hour');
    });

    it('fails open when Redis errors', async () => {
      const redis = {
        eval: jest.fn().mockRejectedValue(new Error('connection refused')),
      };
      const limiter = new ContactAckLimiter(redis as AckLimiterRedis);

      await expect(limiter.allowGlobal()).resolves.toBe(true);
      expect(logged.join(' ')).toContain('connection refused');
    });

    it('fails open when Redis hangs, after 2 s', async () => {
      jest.useFakeTimers();
      const redis = {
        eval: jest.fn(() => new Promise<never>(() => undefined)),
      };
      const limiter = new ContactAckLimiter(redis as AckLimiterRedis);
      let settled = false;

      const result = limiter.allowGlobal().finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(1900);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(200);

      await expect(result).resolves.toBe(true);
    });
  });
});
