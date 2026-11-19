import type { ConfigService } from '@nestjs/config';
import { ChatbotRateLimitGuard } from './chatbot-rate-limit.guard';

/** The client the guard builds; replaced so no test opens a connection. */
const redis = {
  status: 'ready',
  quit: jest.fn(() => Promise.resolve('OK')),
  disconnect: jest.fn(),
};
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => redis),
}));

function make(status: string): ChatbotRateLimitGuard {
  redis.status = status;
  return new ChatbotRateLimitGuard({
    get: (_key: string, fallback: unknown) => fallback,
  } as unknown as ConfigService);
}

beforeEach(() => {
  redis.quit.mockClear();
  redis.disconnect.mockClear();
});

describe('ChatbotRateLimitGuard shutdown', () => {
  /**
   * The hook name is the invariant, not an implementation detail: Nest runs
   * every `onModuleDestroy` before BullMQ closes its workers, so cleaning up
   * there would cut Redis out from under running jobs. See
   * RateLimiterService for the full reasoning.
   */
  it('cleans up in onApplicationShutdown, not onModuleDestroy', () => {
    const guard = make('ready');
    expect(typeof guard.onApplicationShutdown).toBe('function');
    expect(
      (guard as Partial<Record<'onModuleDestroy', unknown>>).onModuleDestroy,
    ).toBeUndefined();
  });

  it('quits a ready connection', async () => {
    await make('ready').onApplicationShutdown();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('drops a connection that is not ready instead of queueing QUIT', async () => {
    await make('reconnecting').onApplicationShutdown();
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to disconnect when QUIT fails, and never rejects', async () => {
    const guard = make('ready');
    redis.quit.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(guard.onApplicationShutdown()).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
