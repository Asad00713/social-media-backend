import { HttpException } from '@nestjs/common';
import { FakeSendLockRedis } from '../../testing/fake-send-lock-redis';
import { SendLockService } from './send-lock.service';

function build() {
  const redis = new FakeSendLockRedis();
  return { redis, lock: new SendLockService(redis) };
}

describe('SendLockService', () => {
  afterEach(() => jest.useRealTimers());

  it('runs two concurrent sends on one key strictly one after the other', async () => {
    jest.useFakeTimers();
    const { lock } = build();
    const events: string[] = [];
    const run = (name: string) =>
      lock.withSendLock('7:conv', 'u1', async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 1000));
        events.push(`${name}:end`);
        return name;
      });

    const a = run('a');
    const b = run('b');
    await jest.advanceTimersByTimeAsync(5000);
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('different keys do not wait for each other', async () => {
    const { lock } = build();
    let inner = false;
    await lock.withSendLock('k1', 'u1', async () => {
      await lock.withSendLock('k2', 'u1', () => {
        inner = true;
        return Promise.resolve();
      });
    });
    expect(inner).toBe(true);
  });

  it('takes the lock with SET ... PX 30000 NX and a user-scoped token', async () => {
    const { lock, redis } = build();
    const set = jest.spyOn(redis, 'set');
    await lock.withSendLock('7:conv', 'u1', () => Promise.resolve());
    expect(set).toHaveBeenCalledWith(
      'inbox-send:7:conv',
      expect.stringMatching(/^u1:.+/),
      'PX',
      30000,
      'NX',
    );
  });

  it('releases the lock after a throwing fn', async () => {
    const { lock, redis } = build();
    await expect(
      lock.withSendLock('k', 'u1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(redis.store.size).toBe(0);
    await expect(
      lock.withSendLock('k', 'u1', () => Promise.resolve('again')),
    ).resolves.toBe('again');
  });

  it('a lock held for 16 s makes the second caller reject with 503 PLATFORM_ERROR, retryable', async () => {
    jest.useFakeTimers();
    const { lock, redis } = build();
    redis.takeOver('inbox-send:k', 'someone:else', 60_000);
    const fn = jest.fn();
    const attempt = lock.withSendLock('k', 'u2', fn);
    const settled = attempt.catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(16_000);
    const err = await settled;
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).getResponse()).toEqual({
      code: 'PLATFORM_ERROR',
      message: 'A teammate is sending right now. Try again.',
      retryable: true,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('waits for a lock that frees up inside the 15 s window', async () => {
    jest.useFakeTimers();
    const { lock, redis } = build();
    redis.takeOver('inbox-send:k', 'someone:else', 2000);
    const attempt = lock.withSendLock('k', 'u2', () => Promise.resolve('ok'));
    await jest.advanceTimersByTimeAsync(3000);
    await expect(attempt).resolves.toBe('ok');
  });

  it('release does not delete a lock another holder took over', async () => {
    const { lock, redis } = build();
    await lock.withSendLock('k', 'u1', () => {
      // Our 30 s expired mid-send and a teammate took the key.
      redis.takeOver('inbox-send:k', 'u2:their-token');
      return Promise.resolve();
    });
    expect(redis.store.get('inbox-send:k')?.value).toBe('u2:their-token');
  });

  it('a release that fails never fails a send that already happened', async () => {
    const { lock, redis } = build();
    jest.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('redis down'));
    await expect(
      lock.withSendLock('k', 'u1', () => Promise.resolve('sent')),
    ).resolves.toBe('sent');
  });

  describe('a Redis that hangs (ioredis queues commands offline forever)', () => {
    const never = () => new Promise<never>(() => undefined);

    it('acquire: a set that never resolves rejects with a retryable 503 inside ~2 s, fn never runs', async () => {
      jest.useFakeTimers();
      const redis = new FakeSendLockRedis();
      jest.spyOn(redis, 'set').mockImplementation(never);
      const lock = new SendLockService(redis);
      const fn = jest.fn();
      const settled = lock.withSendLock('k', 'u1', fn).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(2100);
      const err = await settled;
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(503);
      expect((err as HttpException).getResponse()).toEqual({
        code: 'PLATFORM_ERROR',
        message: 'Sending is briefly unavailable. Try again.',
        retryable: true,
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it('acquire: a set that rejects (Redis error) is the same retryable 503', async () => {
      const redis = new FakeSendLockRedis();
      jest.spyOn(redis, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
      const lock = new SendLockService(redis);
      const fn = jest.fn();
      const err = await lock
        .withSendLock('k', 'u1', fn)
        .catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(503);
      expect(fn).not.toHaveBeenCalled();
    });

    it('release: an eval that never resolves still returns the send result inside ~1 s', async () => {
      jest.useFakeTimers();
      const redis = new FakeSendLockRedis();
      jest.spyOn(redis, 'eval').mockImplementation(never);
      const lock = new SendLockService(redis);
      const done = lock.withSendLock('k', 'u1', () => Promise.resolve('sent'));
      await jest.advanceTimersByTimeAsync(1100);
      await expect(done).resolves.toBe('sent');
    });
  });
});
