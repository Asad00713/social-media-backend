import type { HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

function trackerOf(req: Record<string, unknown>): Promise<string> {
  const guard = new ClientIpThrottlerGuard(
    [] as ThrottlerModuleOptions,
    {} as ThrottlerStorage,
    {} as Reflector,
  );
  return (
    guard as unknown as {
      getTracker: (r: Record<string, unknown>) => Promise<string>;
    }
  ).getTracker(req);
}

describe('ClientIpThrottlerGuard.getTracker', () => {
  it('X-Real-IP wins over X-Forwarded-For (trimmed; first value of an array)', async () => {
    expect(
      await trackerOf({
        headers: {
          'x-real-ip': ' 203.0.113.7 ',
          'x-forwarded-for': '1.1.1.1, 198.51.100.4',
        },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.7');
    expect(
      await trackerOf({
        headers: { 'x-real-ip': ['203.0.113.8', 'x'] },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.8');
  });

  it('without X-Real-IP uses the RIGHTMOST X-Forwarded-For entry', async () => {
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': '1.1.1.1, 10.9.9.9 , 198.51.100.4 ' },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.4');
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': ['1.1.1.1', '198.51.100.9'] },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.9');
    // trailing comma / blanks are skipped
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': '198.51.100.4, ,' },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.4');
  });

  it('a spoofed leftmost X-Forwarded-For hop does not change the tracker', async () => {
    const a = await trackerOf({
      headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.4' },
      ip: '10.0.0.2',
    });
    const b = await trackerOf({
      headers: { 'x-forwarded-for': '8.8.8.8, 7.7.7.7, 198.51.100.4' },
      ip: '10.0.0.2',
    });
    expect(a).toBe('198.51.100.4');
    expect(b).toBe(a);
  });

  it('falls back to req.ip with no usable header', async () => {
    expect(await trackerOf({ headers: {}, ip: '192.0.2.1' })).toBe('192.0.2.1');
    expect(
      await trackerOf({
        headers: { 'x-real-ip': ' ', 'x-forwarded-for': ' , ' },
        ip: '192.0.2.1',
      }),
    ).toBe('192.0.2.1');
    expect(await trackerOf({ ip: '192.0.2.1' })).toBe('192.0.2.1');
  });
});

/**
 * What the 429 body says.
 *
 * Not cosmetic: the frontend puts a failed request's `message` straight into a
 * toast, so the default `"ThrottlerException: Too Many Requests"` reached the
 * person verbatim. The `admin/challenge` limit already caused this once in
 * another form, where a 429 showed up as "could not reach the server".
 */
describe('the 429 it throws', () => {
  /**
   * Awaited, not wrapped in a synchronous try/catch.
   *
   * The base `throwThrottlingException` is `async`, so its `throw` becomes a
   * REJECTED PROMISE that a sync catch cannot see — the first version of this
   * helper used one, which meant removing the override below crashed the Jest
   * worker with an unhandled rejection instead of failing a test. Awaiting the
   * call catches both shapes, so these tests fail (rather than explode) if the
   * override ever goes away.
   */
  async function thrown(timeToBlockExpire: number): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const guard = new ClientIpThrottlerGuard(
      [] as ThrottlerModuleOptions,
      {} as ThrottlerStorage,
      {} as Reflector,
    );
    try {
      await (
        guard as unknown as {
          throwThrottlingException: (c: unknown, d: unknown) => Promise<void>;
        }
      ).throwThrottlingException({} as unknown, {
        limit: 10,
        ttl: 900_000,
        key: 'k',
        tracker: '203.0.113.7',
        totalHits: 11,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire,
      });
    } catch (error) {
      const e = error as HttpException;
      const body = e.getResponse();
      return {
        status: e.getStatus(),
        // The base class responds with a bare string; normalising here is what
        // lets the assertions below read the same way for either shape.
        body:
          typeof body === 'string'
            ? { message: body }
            : (body as Record<string, unknown>),
      };
    }
    throw new Error('expected it to throw');
  }

  it('is a 429', async () => {
    expect((await thrown(30)).status).toBe(429);
  });

  it('never says "ThrottlerException"', async () => {
    // The whole point of the override: this message goes straight into a toast.
    expect(String((await thrown(30)).body.message)).not.toMatch(
      /ThrottlerException/,
    );
  });

  it('carries a machine-readable code', async () => {
    expect((await thrown(30)).body.code).toBe('RATE_LIMITED');
  });

  it('carries retryAfterSeconds, the field the frontend already reads', async () => {
    // `resendCooldownFrom` in the frontend reads exactly this field off a 429
    // to drive its countdown, so reusing the name buys the countdown for free.
    expect((await thrown(45)).body.retryAfterSeconds).toBe(45);
  });

  it.each([
    [1, '1s'],
    [45, '45s'],
    [90, '90s'],
    [91, '2 minutes'],
    [600, '10 minutes'],
  ])('reads a %ps wait as "%s"', async (seconds, text) => {
    expect(String((await thrown(seconds)).body.message)).toContain(text);
  });

  it('never promises a 0s wait', async () => {
    // A sub-second remainder floors to 0 and would read "try again in 0s",
    // telling the person to retry immediately into another 429.
    expect((await thrown(0)).body.retryAfterSeconds).toBe(1);
    expect((await thrown(0.2)).body.retryAfterSeconds).toBe(1);
  });

  it('rounds a fractional wait up, never down', async () => {
    expect((await thrown(44.1)).body.retryAfterSeconds).toBe(45);
  });
});
