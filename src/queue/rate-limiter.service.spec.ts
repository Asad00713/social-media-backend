import type { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';

/** The client the service builds; replaced so no test opens a connection. */
const redis = {
  status: 'ready',
  quit: jest.fn(() => Promise.resolve('OK')),
  disconnect: jest.fn(),
};
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => redis),
}));

function make(status: string): RateLimiterService {
  redis.status = status;
  return new RateLimiterService({
    get: (_key: string, fallback: unknown) => fallback,
  } as unknown as ConfigService);
}

beforeEach(() => {
  redis.quit.mockClear();
  redis.disconnect.mockClear();
});

describe('RateLimiterService shutdown', () => {
  it('quits a ready connection', async () => {
    await make('ready').onModuleDestroy();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('drops a connection that is not ready instead of queueing QUIT', async () => {
    await make('reconnecting').onModuleDestroy();
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to disconnect when QUIT fails, and never rejects', async () => {
    const service = make('ready');
    redis.quit.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
