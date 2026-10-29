import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../../../channels/analytics/redis-client.provider';
import { InboxSendError } from '../lib/send-error';

/** The two Redis calls the lock makes (ioredis satisfies this). */
export interface SendLockRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const KEY_PREFIX = 'inbox-send:';
/** A crashed send frees the thread by itself after this long. */
const LOCK_TTL_MS = 30_000;
const RETRY_EVERY_MS = 250;
const GIVE_UP_AFTER_MS = 15_000;

/**
 * Delete the key only while it still holds OUR token. This is a constant Lua
 * script run by Redis's EVAL command (keys and token are passed as arguments,
 * never interpolated); it is not JavaScript eval.
 */
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One send at a time per conversation. The lock spans the collision check, the
 * platform call and the row write, so a second teammate's collision check sees
 * the first teammate's row. The contract has no "busy" code, so a wait that
 * outlasts the budget is a retryable PLATFORM_ERROR (503).
 */
@Injectable()
export class SendLockService {
  private readonly logger = new Logger(SendLockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: SendLockRedis) {}

  async withSendLock<T>(
    conversationKey: string,
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${KEY_PREFIX}${conversationKey}`;
    const token = `${userId}:${randomUUID()}`;
    const deadline = Date.now() + GIVE_UP_AFTER_MS;

    while (
      (await this.redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK'
    ) {
      if (Date.now() >= deadline) {
        throw new InboxSendError(HttpStatus.SERVICE_UNAVAILABLE, {
          code: 'PLATFORM_ERROR',
          message: 'A teammate is sending right now. Try again.',
          retryable: true,
        });
      }
      await sleep(RETRY_EVERY_MS);
    }

    try {
      return await fn();
    } finally {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (err) {
        // The send already happened; the 30 s expiry frees the key anyway.
        this.logger.error(
          `send lock release failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
