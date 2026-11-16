import { decrypt } from '../../../common/utils/encryption.util';
import {
  CONNECT_LINK_NETWORKS,
  CONNECT_LINK_TTL_MS,
  RESEND_COOLDOWN_MS,
  createLinkToken,
  hashLinkToken,
  invalidNetworks,
  linkStatus,
  linkUrl,
} from './connect-link-rules';

describe('connect-link-rules', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
  });

  afterEach(() => {
    process.env.FRONTEND_URL = ORIGINAL_ENV.FRONTEND_URL;
    if (ORIGINAL_ENV.FRONTEND_URL === undefined)
      delete process.env.FRONTEND_URL;
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = ORIGINAL_ENV.ENCRYPTION_KEY;
    if (ORIGINAL_ENV.ENCRYPTION_KEY === undefined) {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  describe('constants', () => {
    it('offers exactly the eight OAuth social networks', () => {
      expect([...CONNECT_LINK_NETWORKS].sort()).toEqual(
        [
          'facebook',
          'instagram',
          'linkedin',
          'pinterest',
          'threads',
          'tiktok',
          'twitter',
          'youtube',
        ].sort(),
      );
    });

    it('lives for 7 days and resends at most once a minute', () => {
      expect(CONNECT_LINK_TTL_MS).toBe(7 * 24 * 3600 * 1000);
      expect(RESEND_COOLDOWN_MS).toBe(60_000);
    });
  });

  describe('createLinkToken', () => {
    it('makes a 43-char base64url raw token', () => {
      expect(createLinkToken().raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('hashes with hashLinkToken, as 64 hex chars', () => {
      const t = createLinkToken();
      expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hashLinkToken(t.raw)).toBe(t.hash);
    });

    it('stores the raw token encrypted, recoverable with decrypt', () => {
      const t = createLinkToken();
      expect(t.encrypted).not.toContain(t.raw);
      expect(decrypt(t.encrypted)).toBe(t.raw);
    });

    it('never repeats', () => {
      expect(createLinkToken().raw).not.toBe(createLinkToken().raw);
    });
  });

  describe('hashLinkToken', () => {
    it('is deterministic and differs per token', () => {
      expect(hashLinkToken('abc')).toBe(hashLinkToken('abc'));
      expect(hashLinkToken('abc')).not.toBe(hashLinkToken('abd'));
    });
  });

  describe('linkStatus', () => {
    const expiresAt = new Date('2026-11-20T10:00:00.000Z');

    it('is open 1 ms before expiresAt', () => {
      const now = new Date(expiresAt.getTime() - 1);
      expect(linkStatus({ expiresAt, revokedAt: null }, now)).toBe('open');
    });

    it('is expired exactly at expiresAt', () => {
      expect(linkStatus({ expiresAt, revokedAt: null }, expiresAt)).toBe(
        'expired',
      );
    });

    it('is revoked when revoked before expiry', () => {
      const now = new Date(expiresAt.getTime() - 1000);
      expect(
        linkStatus({ expiresAt, revokedAt: new Date(now.getTime() - 5) }, now),
      ).toBe('revoked');
    });

    it('lets revoked win over expired', () => {
      const now = new Date(expiresAt.getTime() + 1000);
      expect(
        linkStatus(
          { expiresAt, revokedAt: new Date(expiresAt.getTime() - 5) },
          now,
        ),
      ).toBe('revoked');
    });
  });

  describe('invalidNetworks', () => {
    it('returns the ids a link may not offer, in order', () => {
      expect(invalidNetworks(['instagram', 'bluesky', 'x'])).toEqual([
        'bluesky',
        'x',
      ]);
    });

    it('returns nothing when every id is offered', () => {
      expect(invalidNetworks([...CONNECT_LINK_NETWORKS])).toEqual([]);
    });

    it('rejects networks that connect by other means', () => {
      expect(
        invalidNetworks(['mastodon', 'telegram', 'google_drive', 'slack']),
      ).toEqual(['mastodon', 'telegram', 'google_drive', 'slack']);
    });
  });

  describe('linkUrl', () => {
    it('joins FRONTEND_URL and /c/<token>', () => {
      process.env.FRONTEND_URL = 'https://app.example.com';
      expect(linkUrl('tok123')).toBe('https://app.example.com/c/tok123');
    });

    it('falls back to localhost:3000', () => {
      delete process.env.FRONTEND_URL;
      expect(linkUrl('tok123')).toBe('http://localhost:3000/c/tok123');
    });
  });
});
