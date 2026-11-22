import { decrypt } from './encryption.util';
import {
  TotpSecretCorruptError,
  decryptStrict,
  encryptTotpSecret,
} from './totp-secret.util';

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('totp-secret.util', () => {
  const before = process.env.ENCRYPTION_KEY;
  let warn: jest.SpyInstance;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = before;
    warn.mockRestore();
  });

  it('round-trips and never stores the plaintext', () => {
    const enc = encryptTotpSecret(SECRET);
    expect(enc).not.toContain(SECRET);
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptStrict(enc)).toBe(SECRET);
  });

  it('a plaintext column throws where decrypt would pass it through', () => {
    expect(decrypt(SECRET)).toBe(SECRET); // the loose path this util exists to refuse
    expect(() => decryptStrict(SECRET)).toThrow(TotpSecretCorruptError);
  });

  it('a flipped ciphertext character throws', () => {
    const enc = encryptTotpSecret(SECRET);
    const [iv, tag, ct] = enc.split(':');
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptStrict(`${iv}:${tag}:${flipped}`)).toThrow(
      TotpSecretCorruptError,
    );
  });

  it('empty, missing parts and extra parts throw', () => {
    const enc = encryptTotpSecret(SECRET);
    const [iv, tag, ct] = enc.split(':');
    expect(() => decryptStrict('')).toThrow(TotpSecretCorruptError);
    expect(() => decryptStrict(`${iv}:${tag}`)).toThrow(TotpSecretCorruptError);
    expect(() => decryptStrict(`${iv}::${ct}`)).toThrow(TotpSecretCorruptError);
    expect(() => decryptStrict(`${iv}:${tag}:${ct}:x`)).toThrow(
      TotpSecretCorruptError,
    );
  });

  it('a truncated GCM tag or a short IV throws (lengths pinned at 16 bytes)', () => {
    const enc = encryptTotpSecret(SECRET);
    const [iv, tag, ct] = enc.split(':');
    const short = (b64: string, n: number) =>
      Buffer.from(b64, 'base64').subarray(0, n).toString('base64');
    expect(() => decryptStrict(`${iv}:${short(tag, 4)}:${ct}`)).toThrow(
      TotpSecretCorruptError,
    );
    expect(() => decryptStrict(`${short(iv, 12)}:${tag}:${ct}`)).toThrow(
      TotpSecretCorruptError,
    );
    expect(decryptStrict(`${iv}:${tag}:${ct}`)).toBe(SECRET);
  });

  it('encryptTotpSecret refuses an empty secret (encrypt would return it as-is)', () => {
    expect(() => encryptTotpSecret('')).toThrow();
  });
});
