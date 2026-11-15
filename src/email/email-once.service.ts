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
const CLAIM_TIMEOUT_MS = 2000;

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
   * retry would find the key taken and the mail would never go. Never throws;
   * if Redis is down the claim simply stays until its TTL.
   */
  async release(key: string): Promise<void> {
    try {
      await this.redis.del(`${KEY_PREFIX}${key}`);
    } catch (err) {
      this.logger.warn(
        `email-once release for ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** True the first time `key` is claimed within `ttlSeconds`, false after. */
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`redis timeout after ${CLAIM_TIMEOUT_MS} ms`)),
        CLAIM_TIMEOUT_MS,
      );
    });
    try {
      const reply = await Promise.race([
        this.redis.set(`${KEY_PREFIX}${key}`, '1', 'EX', ttlSeconds, 'NX'),
        timeout,
      ]);
      return reply === 'OK';
    } catch (err) {
      this.logger.warn(
        `email-once claim for ${key} failed open: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}
