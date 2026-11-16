import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../channels/analytics/redis-client.provider';

/** The one Redis call a claim makes (ioredis satisfies this). */
export interface EmailOnceRedis {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

const KEY_PREFIX = 'email-once:';
/** ioredis queues commands offline forever, so a hung Redis must not hang a send. */
const REDIS_TIMEOUT_MS = 2000;

/** `command`, or a rejection once REDIS_TIMEOUT_MS has passed. */
async function withTimeout<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redis timeout after ${REDIS_TIMEOUT_MS} ms`)),
      REDIS_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cross-day dedupe for mail Resend's 24 h idempotency window can't cover
 * (incident and billing reminders). Fails open: if Redis is down the mail is
 * sent and a warning logged, because a missed email costs more than a rare
 * duplicate.
 */
@Injectable()
export class EmailOnceService {
  private readonly logger = new Logger(EmailOnceService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: EmailOnceRedis) {}

  /**
   * Gives a claim back, for a send that failed after it: without this the
   * retry would find the key taken and the mail would never go. Never throws
   * and never waits more than 2 s; if Redis is down or hangs the claim simply
   * stays until its TTL.
   */
  async release(key: string): Promise<void> {
    try {
      await withTimeout(this.redis.del(`${KEY_PREFIX}${key}`));
    } catch (err) {
      this.logger.warn(
        `email-once release for ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** True the first time `key` is claimed within `ttlSeconds`, false after. */
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const reply = await withTimeout(
        this.redis.set(`${KEY_PREFIX}${key}`, '1', 'EX', ttlSeconds, 'NX'),
      );
      return reply === 'OK';
    } catch (err) {
      this.logger.warn(
        `email-once claim for ${key} failed open: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }
}
