import type Redis from 'ioredis';

/**
 * Closes an ioredis connection as part of application shutdown.
 *
 * Shared by the modules that build their Redis client in a `useFactory`
 * provider. A factory's return value is a plain object to Nest, not a
 * provider class, so it is given no lifecycle hooks — the client would stay
 * open through shutdown and keep the process alive. A tiny service that
 * injects the client and implements the hook is what gives it one.
 *
 * Both rules this encodes are deliberate:
 *
 * - **`onApplicationShutdown`, never `onModuleDestroy`.** Nest runs every
 *   `onModuleDestroy` before `@nestjs/bullmq` closes its workers in
 *   `onApplicationShutdown`. Closing Redis in the earlier hook cuts the
 *   connection out from under jobs that are still running.
 * - **A connection that is not ready is dropped, not quit.** QUIT would sit
 *   in ioredis's offline queue waiting for a connection that is not coming,
 *   holding shutdown open until the platform's patience runs out. A failed
 *   QUIT falls back to the same drop, so this never rejects.
 */
export async function closeRedisConnection(client: Redis): Promise<void> {
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  await client.quit().catch(() => client.disconnect());
}
