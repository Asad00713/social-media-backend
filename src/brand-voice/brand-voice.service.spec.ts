import { HttpException, Logger } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import { BrandVoiceService } from './brand-voice.service';
import { DEFAULT_BRAND_VOICE_FIELDS } from './brand-voice.types';

const WS = '00000000-0000-4000-8000-000000000001';
const SECRET = 'Hand-poured soy candles';

/** A query that fails: whatever is chained, awaiting it rejects. */
function failingQuery(): unknown {
  const fail = Promise.reject(new Error(`Failed query, params: ${SECRET}`));
  fail.catch(() => undefined);
  const q: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoUpdate']) {
    q[m] = () => q;
  }
  q.then = (ok: never, ko: never) => fail.then(ok, ko);
  return q;
}

/** A query that resolves to `rows` whatever is chained onto it. */
function query(rows: unknown[]): unknown {
  const q: Record<string, unknown> = {};
  for (const m of [
    'from',
    'where',
    'for',
    'limit',
    'values',
    'onConflictDoNothing',
    'returning',
  ]) {
    q[m] = () => q;
  }
  q.then = (ok: (v: unknown) => unknown, ko: never) =>
    Promise.resolve(rows).then(ok, ko);
  return q;
}

describe('BrandVoiceService', () => {
  let warn: jest.SpyInstance<void, [message: unknown, ...rest: unknown[]]>;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('promptFor answers "" and warns when the read fails', async () => {
    const db = {
      select: () => {
        throw new Error(`select failed for ${SECRET}`);
      },
    } as unknown as DbType;
    const svc = new BrandVoiceService(db);

    await expect(svc.promptFor(WS, { platform: 'instagram' })).resolves.toBe(
      '',
    );
    await expect(svc.loadPromptSource(WS)).resolves.toEqual({
      voice: DEFAULT_BRAND_VOICE_FIELDS,
      savedHashtags: [],
    });
    expect(warn).toHaveBeenCalled();
    for (const [msg] of warn.mock.calls) {
      expect(String(msg)).not.toContain(SECRET);
    }
  });

  it('promptFor answers "" when the query rejects', async () => {
    const db = { select: () => failingQuery() } as unknown as DbType;
    await expect(new BrandVoiceService(db).promptFor(WS)).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('seedFromBrand resolves when the write fails', async () => {
    const db = {
      select: () => {
        throw new Error('select failed');
      },
      insert: () => failingQuery(),
    } as unknown as DbType;
    const svc = new BrandVoiceService(db);

    await expect(
      svc.seedFromBrand(
        WS,
        { sells: SECRET, voice: ['warm'], audience: null },
        { sourcePlatform: null },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('a first save that loses the insert race is 409 VERSION_CONFLICT', async () => {
    // No row to lock, and the insert finds one another save just committed.
    const tx = { select: () => query([]), insert: () => query([]) };
    const db = {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as DbType;

    const err = await new BrandVoiceService(db)
      .update(WS, { version: 1, tone: ['Warm'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(409);
    expect((err as HttpException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'VERSION_CONFLICT',
      message: 'Someone else just changed the brand voice. Reload to see it.',
    });
  });
});
