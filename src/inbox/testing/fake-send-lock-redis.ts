/**
 * An in-memory stand-in for the two Redis calls the send lock makes, with
 * their real semantics: `SET key value PX ms NX` only wins on a missing or
 * expired key, and the release script deletes only when the stored value is
 * still the caller's token.
 */
export class FakeSendLockRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();

  set(
    key: string,
    value: string,
    ...[, ttlMs]: ['PX', number, 'NX']
  ): Promise<'OK' | null> {
    const held = this.store.get(key);
    if (held && held.expiresAt > Date.now()) return Promise.resolve(null);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve('OK');
  }

  eval(_script: string, _numKeys: number, key: string, token: string) {
    const held = this.store.get(key);
    if (held && held.value === token) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  /** Test hook: another holder takes the lock over (the first one expired). */
  takeOver(key: string, value: string, ttlMs = 30_000): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
