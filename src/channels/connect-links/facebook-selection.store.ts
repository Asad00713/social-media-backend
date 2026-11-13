import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt } from '../../common/utils/encryption.util';
import { REDIS_CLIENT } from '../analytics/redis-client.provider';
import { connectLinkError } from './lib/connect-link-errors';

/** A selection lives 15 minutes: long enough to tick Pages, no longer. */
export const FB_SELECTION_TTL_SECONDS = 900;

/** 24 random bytes as base64url. */
const SELECTION_ID = /^[A-Za-z0-9_-]{32}$/;

export function fbSelectionKey(id: string): string {
  return `connect-link:fb-selection:${id}`;
}

/** The ioredis calls this store makes (a narrow type, easy to fake). */
export interface SelectionRedis {
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

interface StoredSelection {
  linkId: string;
  /** The Facebook USER token, encrypted at rest like every other token. */
  userAccessToken: string;
}

/**
 * Facebook on a connect link: the callback cannot hand the user token to the
 * client's browser, so it parks it here under a random id and the link page
 * names that id to list and connect Pages. Bound to its link; single use on
 * connect; gone after 15 minutes.
 */
@Injectable()
export class FacebookSelectionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: SelectionRedis) {}

  async create(linkId: string, userAccessToken: string): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    const value: StoredSelection = {
      linkId,
      userAccessToken: encrypt(userAccessToken),
    };
    await this.redis.set(
      fbSelectionKey(id),
      JSON.stringify(value),
      'EX',
      FB_SELECTION_TTL_SECONDS,
    );
    return id;
  }

  /** The user token of a live selection of this link; left in place. */
  async read(linkId: string, id: string): Promise<string> {
    const stored = await this.load(linkId, id);
    return decrypt(stored.userAccessToken);
  }

  /**
   * The user token, and the selection is gone. Of two concurrent takes only
   * the one whose delete removed the key wins. Another link's selection is
   * refused and left alone (a stranger cannot burn it).
   */
  async take(linkId: string, id: string): Promise<string> {
    const stored = await this.load(linkId, id);
    const removed = await this.redis.del(fbSelectionKey(id));
    if (removed !== 1) throw expired();
    return decrypt(stored.userAccessToken);
  }

  private async load(linkId: string, id: string): Promise<StoredSelection> {
    if (typeof id !== 'string' || !SELECTION_ID.test(id)) throw expired();
    const raw = await this.redis.get(fbSelectionKey(id));
    if (!raw) throw expired();
    let stored: Partial<StoredSelection>;
    try {
      stored = JSON.parse(raw) as Partial<StoredSelection>;
    } catch {
      throw expired();
    }
    if (
      stored.linkId !== linkId ||
      typeof stored.userAccessToken !== 'string'
    ) {
      throw expired();
    }
    return stored as StoredSelection;
  }
}

function expired() {
  return connectLinkError(
    'SELECTION_EXPIRED',
    'This Facebook sign-in has expired. Connect Facebook again.',
  );
}
