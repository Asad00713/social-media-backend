import { BadRequestException } from '@nestjs/common';
import { MaestroKeyService } from './maestro-key.service';
import { encrypt } from '../../common/utils/encryption.util';

/** Minimal Drizzle stand-in: records writes, replays a canned row. */
function makeDb(row: Record<string, unknown> | undefined) {
  const sets: Record<string, unknown>[] = [];
  return {
    sets,
    query: { workspace: { findFirst: jest.fn().mockResolvedValue(row) } },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
}

const VALID_KEY = 'sk-ant-api03-abcdefghijklmnop4f2a';

describe('MaestroKeyService', () => {
  const ORIGINAL_ENV = process.env;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    // 64 hex chars, required by encryption.util.
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('getStatus', () => {
    it('reports no key for a fresh workspace', async () => {
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      const status = await svc.getStatus('ws-1');

      expect(status).toEqual({
        hasOwnKey: false,
        hint: null,
        setAt: null,
        onboarded: false,
      });
    });

    it('returns a MASKED hint and never the key itself', async () => {
      const setAt = new Date('2026-08-26T10:00:00.000Z');
      const db = makeDb({
        maestroAnthropicKey: encrypt(VALID_KEY),
        maestroAnthropicKeyHint: '4f2a',
        maestroAnthropicKeySetAt: setAt,
        maestroOnboardedAt: setAt,
      });
      const svc = new MaestroKeyService(db as never);

      const status = await svc.getStatus('ws-1');

      expect(status.hasOwnKey).toBe(true);
      expect(status.hint).toBe('sk-ant-…4f2a');
      expect(status.onboarded).toBe(true);
      // The real secret must not appear anywhere in the payload.
      expect(JSON.stringify(status)).not.toContain(VALID_KEY);
    });
  });

  describe('getDecryptedKey', () => {
    it('round-trips the stored key', async () => {
      const db = makeDb({ maestroAnthropicKey: encrypt(VALID_KEY) });
      const svc = new MaestroKeyService(db as never);

      await expect(svc.getDecryptedKey('ws-1')).resolves.toBe(VALID_KEY);
    });

    it('returns null when the workspace has no key', async () => {
      const svc = new MaestroKeyService(makeDb({}) as never);

      await expect(svc.getDecryptedKey('ws-1')).resolves.toBeNull();
    });

    it('returns null instead of throwing when the value cannot be decrypted', async () => {
      // Simulates a rotated ENCRYPTION_KEY: chat must degrade, not crash.
      const db = makeDb({ maestroAnthropicKey: 'aaa:bbb:ccc' });
      const svc = new MaestroKeyService(db as never);

      await expect(svc.getDecryptedKey('ws-1')).resolves.toBeNull();
    });
  });

  describe('setKey', () => {
    it('rejects a key that is not an Anthropic key without calling out', async () => {
      const svc = new MaestroKeyService(makeDb({}) as never);

      await expect(svc.setKey('ws-1', 'not-a-key')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a key Anthropic returns 401 for', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 401 } as Response);
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      await expect(svc.setKey('ws-1', VALID_KEY)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // Nothing may be persisted when validation fails.
      expect(db.sets).toHaveLength(0);
    });

    it('refuses to store a key it could not verify (network failure)', async () => {
      fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      await expect(svc.setKey('ws-1', VALID_KEY)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(db.sets).toHaveLength(0);
    });

    it('stores the key ENCRYPTED, never in plaintext', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      await svc.setKey('ws-1', VALID_KEY);

      expect(db.sets).toHaveLength(1);
      const written = db.sets[0].maestroAnthropicKey as string;
      expect(written).not.toBe(VALID_KEY);
      expect(written).toContain(':'); // iv:authTag:ciphertext
      expect(db.sets[0].maestroAnthropicKeyHint).toBe('4f2a');
    });

    it('sends the key to Anthropic for validation, not to any other host', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
      const svc = new MaestroKeyService(makeDb({}) as never);

      await svc.setKey('ws-1', VALID_KEY);

      const [firstCall] = fetchSpy.mock.calls as unknown[][];
      const url = String(firstCall[0]);
      expect(new URL(url).host).toBe('api.anthropic.com');
    });
  });

  describe('removeKey', () => {
    it('clears the key and its hint', async () => {
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      await svc.removeKey('ws-1');

      expect(db.sets[0]).toMatchObject({
        maestroAnthropicKey: null,
        maestroAnthropicKeyHint: null,
        maestroAnthropicKeySetAt: null,
      });
    });
  });

  describe('markOnboarded', () => {
    it('stamps the wizard as complete', async () => {
      const db = makeDb({});
      const svc = new MaestroKeyService(db as never);

      await svc.markOnboarded('ws-1');

      expect(db.sets[0].maestroOnboardedAt).toBeInstanceOf(Date);
    });
  });
});
