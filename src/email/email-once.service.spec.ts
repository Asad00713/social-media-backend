import { Logger } from '@nestjs/common';
import { EmailOnceService, type EmailOnceRedis } from './email-once.service';

/** An in-memory `SET NX` with the same answers ioredis gives. */
function fakeRedis() {
  const keys = new Set<string>();
  const set = jest.fn((key: string) => {
    if (keys.has(key)) return Promise.resolve(null);
    keys.add(key);
    return Promise.resolve('OK' as const);
  });
  return { redis: { set } as EmailOnceRedis, set };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('EmailOnceService', () => {
  it('claim returns true then false, and true when Redis throws', async () => {
    const { redis, set } = fakeRedis();
    const once = new EmailOnceService(redis);
    await expect(once.claim('trial-ending.ws1', 86400)).resolves.toBe(true);
    await expect(once.claim('trial-ending.ws1', 86400)).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith(
      'email-once:trial-ending.ws1',
      '1',
      'EX',
      86400,
      'NX',
    );

    set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(once.claim('trial-ending.ws2', 86400)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('fails open when Redis never answers', async () => {
    jest.useFakeTimers();
    const redis: EmailOnceRedis = { set: () => new Promise(() => undefined) };
    const claim = new EmailOnceService(redis).claim('welcome.u1', 60);
    await jest.advanceTimersByTimeAsync(2000);
    await expect(claim).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });
});
