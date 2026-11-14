import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import {
  ReportsPublicThrottlerGuard,
  unsubscribeTokenTracker,
} from './reports-public-throttler.guard';

function trackerOf(req: Record<string, unknown>): Promise<string> {
  const guard = new ReportsPublicThrottlerGuard(
    [{ ttl: 60_000, limit: 100 }] as ThrottlerModuleOptions,
    { increment: jest.fn() },
    new Reflector(),
  );
  return (
    guard as unknown as {
      getTracker(r: Record<string, unknown>): Promise<string>;
    }
  ).getTracker(req);
}

describe('ReportsPublicThrottlerGuard.getTracker', () => {
  it('keys a spoofed long list on its first entry', async () => {
    await expect(
      trackerOf({
        headers: { 'x-forwarded-for': ' 3.3.3.3 , 9.9.9.9, 8.8.8.8' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('3.3.3.3');
  });

  it('reads the first element when the header arrives as an array', async () => {
    await expect(
      trackerOf({
        headers: { 'x-forwarded-for': ['4.4.4.4, 5.5.5.5'] },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('4.4.4.4');
  });

  it('falls back to req.ip with no header or a blank one', async () => {
    await expect(trackerOf({ headers: {}, ip: '10.0.0.1' })).resolves.toBe(
      '10.0.0.1',
    );
    await expect(
      trackerOf({ headers: { 'x-forwarded-for': ' ' }, ip: '10.0.0.1' }),
    ).resolves.toBe('10.0.0.1');
    await expect(
      trackerOf({
        headers: { 'x-forwarded-for': ' , 1.1.1.1' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('10.0.0.1');
  });
});

describe('unsubscribeTokenTracker', () => {
  it('keys on the token whatever the forwarded address says', () => {
    const at = (xff: string, ip: string) =>
      unsubscribeTokenTracker({
        params: { token: 'abc.def.ghi' },
        headers: { 'x-forwarded-for': xff },
        ip,
      });
    expect(at('1.1.1.1', '10.0.0.1')).toBe('unsub:abc.def.ghi');
    expect(at('2.2.2.2', '10.0.0.2')).toBe('unsub:abc.def.ghi');
  });
});
