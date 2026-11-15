import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../channels/analytics/redis-client.provider';

/** The one Redis call the limiter makes (ioredis satisfies this). */
export interface AckLimiterRedis {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const KEY_PREFIX = 'contact-ack:';
/** Acknowledgements one address may be sent per window. */
export const ACKS_PER_ADDRESS = 2;
export const ACK_WINDOW_SECONDS = 3600;
/** ioredis queues commands offline forever, so a hung Redis must not hang the form. */
const REDIS_TIMEOUT_MS = 2000;

/** INCR, and start the window on the first hit, in one atomic step. */
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * Caps the branded acknowledgement per recipient address, so the public
 * contact form cannot be used to mail a stranger repeatedly. The key is a
 * hash of the lowercased address: the address itself is never stored or
 * logged. Fails closed: if Redis errors, the acknowledgement is skipped (the
 * enquiry to support is unaffected).
 */
@Injectable()
export class ContactAckLimiter {
  private readonly logger = new Logger(ContactAckLimiter.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: AckLimiterRedis) {}

  /** True while this address is within its cap; counts the attempt. Never throws. */
  async allow(address: string): Promise<boolean> {
    const digest = createHash('sha256')
      .update(address.trim().toLowerCase())
      .digest('hex');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`redis timeout after ${REDIS_TIMEOUT_MS} ms`)),
        REDIS_TIMEOUT_MS,
      );
    });
    try {
      const count = await Promise.race([
        this.redis.eval(
          COUNT_SCRIPT,
          1,
          `${KEY_PREFIX}${digest}`,
          String(ACK_WINDOW_SECONDS),
        ),
        timeout,
      ]);
      return typeof count === 'number' && count <= ACKS_PER_ADDRESS;
    } catch (err) {
      this.logger.warn(
        `Contact ack limiter unavailable, acknowledgement skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
