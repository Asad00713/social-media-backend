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
