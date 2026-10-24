interface Entry<V> {
  version: string;
  expiresAt: number;
  value: V;
}

/**
 * A small TTL cache whose entries also carry a version: a lookup with a
 * different version is a miss, so new data invalidates before the TTL runs
 * out. Evicts the oldest-inserted entry when full (FIFO).
 */
export class BestTimesCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string, version: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt || entry.version !== version) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  set(key: string, version: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, {
      version,
      expiresAt: this.now() + this.ttlMs,
      value,
    });
  }
}
