import type Redis from 'ioredis';
import { EmailModule } from './email.module';

function fakeRedis(status: string) {
  const redis = {
    status,
    quit: jest.fn(() => Promise.resolve('OK')),
    disconnect: jest.fn(),
  };
  return { redis, module: new EmailModule(redis as unknown as Redis) };
}

describe('EmailModule shutdown', () => {
  it('quits its Redis connection when it is ready', async () => {
    const { redis, module } = fakeRedis('ready');
    await module.onModuleDestroy();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('drops a connection that is not ready instead of queueing QUIT', async () => {
    const { redis, module } = fakeRedis('reconnecting');
    await module.onModuleDestroy();
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to disconnect when QUIT fails', async () => {
    const { redis, module } = fakeRedis('ready');
    redis.quit.mockRejectedValueOnce(new Error('closed'));
    await module.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
