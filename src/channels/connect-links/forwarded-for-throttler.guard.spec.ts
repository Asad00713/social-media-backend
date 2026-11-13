import type { Reflector } from '@nestjs/core';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { ForwardedForThrottlerGuard } from './forwarded-for-throttler.guard';

function trackerOf(req: Record<string, unknown>): Promise<string> {
  const guard = new ForwardedForThrottlerGuard(
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

describe('ForwardedForThrottlerGuard.getTracker', () => {
  it('uses the first X-Forwarded-For hop, trimmed', async () => {
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1, 10.0.0.2' },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.7');
  });

  it('works with a single hop and with an array header', async () => {
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': '198.51.100.4' },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.4');
    expect(
      await trackerOf({
        headers: { 'x-forwarded-for': ['198.51.100.9, 10.0.0.1'] },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.9');
  });

  it('falls back to req.ip without the header or with an empty one', async () => {
    expect(await trackerOf({ headers: {}, ip: '192.0.2.1' })).toBe('192.0.2.1');
    expect(
      await trackerOf({ headers: { 'x-forwarded-for': ' ' }, ip: '192.0.2.1' }),
    ).toBe('192.0.2.1');
  });
});
