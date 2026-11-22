import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  SESSION_CHECK_MAX,
  SESSION_CHECK_TOMBSTONE_MS,
  SESSION_CHECK_TTL_MS,
  SessionCheck,
} from './session-check';
import { SessionStore } from './session-store';

const SID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function build(live = true) {
  const store = { isLive: jest.fn().mockResolvedValue(live) };
  const check = new SessionCheck(store as unknown as SessionStore);
  return { store, check };
}

describe('SessionCheck', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  it('pins the 30 s cache and its bound', () => {
    expect(SESSION_CHECK_TTL_MS).toBe(30_000);
    expect(SESSION_CHECK_MAX).toBe(10_000);
  });

  it('reads the store once for two calls within 30 s', async () => {
    const { store, check } = build(true);
    await expect(check.isLive(SID, USER)).resolves.toBe(true);
    jest.advanceTimersByTime(29_999);
    await expect(check.isLive(SID, USER)).resolves.toBe(true);
    expect(store.isLive).toHaveBeenCalledTimes(1);
    expect(store.isLive).toHaveBeenCalledWith(SID, USER);
  });

  it('reads the store again after 30 001 ms', async () => {
    const { store, check } = build(true);
    await check.isLive(SID, USER);
    jest.advanceTimersByTime(30_001);
    await check.isLive(SID, USER);
    expect(store.isLive).toHaveBeenCalledTimes(2);
  });

  it('caches false too (a revoked sid does not hit the database every request)', async () => {
    const { store, check } = build(false);
    await expect(check.isLive(SID, USER)).resolves.toBe(false);
    await expect(check.isLive(SID, USER)).resolves.toBe(false);
    expect(store.isLive).toHaveBeenCalledTimes(1);
  });

  it('a cached true becomes false right after forget(sid)', async () => {
    const { store, check } = build(true);
    await expect(check.isLive(SID, USER)).resolves.toBe(true);
    store.isLive.mockResolvedValue(false);
    check.forget(SID);
    await expect(check.isLive(SID, USER)).resolves.toBe(false);
    expect(store.isLive).toHaveBeenCalledTimes(2);
  });

  it('a cached answer for one user is never served for another', async () => {
    const { store, check } = build(true);
    await check.isLive(SID, USER);
    store.isLive.mockResolvedValue(false);
    await expect(
      check.isLive(SID, '33333333-3333-4333-8333-333333333333'),
    ).resolves.toBe(false);
    expect(store.isLive).toHaveBeenCalledTimes(2);
  });

  it('the map never exceeds SESSION_CHECK_MAX, evicting the oldest', async () => {
    const { store, check } = build(true);
    const sid = (i: number) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (let i = 0; i < SESSION_CHECK_MAX + 5; i++)
      await check.isLive(sid(i), USER);
    expect(check.size).toBe(SESSION_CHECK_MAX);
    store.isLive.mockClear();
    await check.isLive(sid(0), USER); // evicted: read again
    await check.isLive(sid(SESSION_CHECK_MAX + 4), USER); // newest: cached
    expect(store.isLive).toHaveBeenCalledTimes(1);
    expect(store.isLive).toHaveBeenCalledWith(sid(0), USER);
  });
});

describe('SessionStore <-> SessionCheck wiring', () => {
  it('Nest resolves the pair and the store forgets through the same check', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionStore,
        SessionCheck,
        { provide: DRIZZLE, useValue: {} },
      ],
    }).compile();
    const store = moduleRef.get(SessionStore);
    const check = moduleRef.get(SessionCheck);
    const forget = jest.spyOn(check, 'forget');
    (store as unknown as { forgetAll(ids: string[]): void }).forgetAll([SID]);
    expect(forget).toHaveBeenCalledWith(SID);
  });
});

describe('SessionCheck after a revoke (no stale true re-cached)', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  function deferred() {
    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('a read in flight when forget runs answers but does not cache its stale true', async () => {
    const store = { isLive: jest.fn() };
    const check = new SessionCheck(store as unknown as SessionStore);
    const stale = deferred();
    store.isLive.mockReturnValueOnce(stale.promise);

    const inFlight = check.isLive(SID, USER);
    check.forget(SID); // the revoke lands while the read is pending
    stale.resolve(true); // the read saw the row before the UPDATE
    await expect(inFlight).resolves.toBe(true);

    store.isLive.mockResolvedValue(false);
    await expect(check.isLive(SID, USER)).resolves.toBe(false);
    expect(store.isLive).toHaveBeenCalledTimes(2);
  });

  it('a true read between the revoke and its COMMIT is never cached', async () => {
    const store = { isLive: jest.fn().mockResolvedValue(true) };
    const check = new SessionCheck(store as unknown as SessionStore);
    check.forget(SID); // revoke ran inside a transaction, not yet committed
    await check.isLive(SID, USER); // still live in the database
    await check.isLive(SID, USER);
    expect(store.isLive).toHaveBeenCalledTimes(2);
    store.isLive.mockResolvedValue(false); // committed
    await expect(check.isLive(SID, USER)).resolves.toBe(false);
  });

  it('false is still cached during the tombstone, and true caches again once it lapses', async () => {
    const store = { isLive: jest.fn().mockResolvedValue(false) };
    const check = new SessionCheck(store as unknown as SessionStore);
    check.forget(SID);
    await check.isLive(SID, USER);
    await check.isLive(SID, USER);
    expect(store.isLive).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(SESSION_CHECK_TOMBSTONE_MS + 1);
    store.isLive.mockResolvedValue(true);
    await check.isLive(SID, USER);
    await check.isLive(SID, USER);
    expect(store.isLive).toHaveBeenCalledTimes(2);
  });
});
