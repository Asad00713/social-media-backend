import { Logger } from '@nestjs/common';
import { EmailOnceService, type EmailOnceRedis } from './email-once.service';

/** An in-memory `SET NX` with the same answers ioredis gives. */
function fakeRedis() {
  const keys = new Set<string>();
  const del = jest.fn((key: string) =>
    Promise.resolve(keys.delete(key) ? 1 : 0),
  );
  const set = jest.fn((key: string) => {
    if (keys.has(key)) return Promise.resolve(null);
    keys.add(key);
    return Promise.resolve('OK' as const);
  });
  return { redis: { set, del } as EmailOnceRedis, set, del };
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

  it('release gives the claim back so the next claim succeeds', async () => {
    const { redis, del } = fakeRedis();
    const once = new EmailOnceService(redis);
    await expect(once.claim('trial-ending.7', 60)).resolves.toBe(true);
    await expect(once.claim('trial-ending.7', 60)).resolves.toBe(false);

    await once.release('trial-ending.7');

    expect(del).toHaveBeenCalledWith('email-once:trial-ending.7');
    await expect(once.claim('trial-ending.7', 60)).resolves.toBe(true);
  });

  it('release never throws when Redis does', async () => {
    const { redis, del } = fakeRedis();
    del.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      new EmailOnceService(redis).release('trial-ending.8'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('fails open when Redis never answers', async () => {
    jest.useFakeTimers();
    const redis: EmailOnceRedis = {
      set: () => new Promise(() => undefined),
      del: () => Promise.resolve(0),
    };
    const claim = new EmailOnceService(redis).claim('welcome.u1', 60);
    await jest.advanceTimersByTimeAsync(2000);
    await expect(claim).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });
});
