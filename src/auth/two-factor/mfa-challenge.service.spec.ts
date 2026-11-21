import { createHmac } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import * as jsonwebtoken from 'jsonwebtoken';
import {
  MAX_CHALLENGE_ATTEMPTS,
  MFA_CHALLENGE_TTL_SECONDS,
  MfaChallengeService,
} from './mfa-challenge.service';

const ACCESS = 'access-secret';
const CID = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const DERIVED = createHmac('sha256', ACCESS)
  .update('mfa-challenge')
  .digest('hex');

/** A fake db: insert -> returning gives the cid; select gives `row`. */
function build(
  opts: { row?: unknown; secrets?: Record<string, string | undefined> } = {},
) {
  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const db = {
    delete: jest.fn(() => ({ where: deleteWhere })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ id: CID }]),
      })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest
            .fn()
            .mockResolvedValue(
              'row' in opts
                ? opts.row
                  ? [opts.row]
                  : []
                : [{ id: CID, userId: USER, deviceHash: null }],
            ),
        })),
      })),
    })),
  };
  const secrets = opts.secrets ?? { JWT_ACCESS_SECRET: ACCESS };
  const config = { get: (k: string) => secrets[k] };
  const service = new MfaChallengeService(
    db as never,
    new JwtService({}),
    config as never,
  );
  return { service, db, deleteWhere };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
  throw new Error('expected a rejection');
};

describe('MfaChallengeService (token)', () => {
  it('pins the TTL and the attempt cap', () => {
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(MAX_CHALLENGE_ATTEMPTS).toBe(5);
  });

  it('signs {sub, cid, purpose:"mfa"} for 5 minutes with a key derived from the access secret', async () => {
    const { service } = build();
    const token = await service.create(USER, 'd'.repeat(64));
    const claims = jsonwebtoken.verify(token, DERIVED) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ sub: USER, cid: CID, purpose: 'mfa' });
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(claims).not.toHaveProperty('email');
  });

  it('the challenge does NOT verify with JWT_ACCESS_SECRET (it is no access token)', async () => {
    const { service } = build();
    const token = await service.create(USER, null);
    expect(() => jsonwebtoken.verify(token, ACCESS)).toThrow();
  });

  it('MFA_CHALLENGE_SECRET, when set, is the key', async () => {
    const { service } = build({
      secrets: { JWT_ACCESS_SECRET: ACCESS, MFA_CHALLENGE_SECRET: 'own-key' },
    });
    const token = await service.create(USER, null);
    expect(() => jsonwebtoken.verify(token, 'own-key')).not.toThrow();
    expect(() => jsonwebtoken.verify(token, DERIVED)).toThrow();
  });

  it('create prunes that user’s mfa challenges expired more than a day ago (B8)', async () => {
    const { service, db, deleteWhere } = build();
    await service.create(USER, null);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('open returns cid, user and device for a good token', async () => {
    const { service } = build({
      row: { id: CID, userId: USER, deviceHash: 'd'.repeat(64) },
    });
    const token = await service.create(USER, 'd'.repeat(64));
    await expect(service.open(token)).resolves.toEqual({
      cid: CID,
      userId: USER,
      deviceHash: 'd'.repeat(64),
    });
  });

  it.each([
    [
      'purpose admin-login (signed with the same key)',
      () =>
        jsonwebtoken.sign(
          { sub: USER, cid: CID, purpose: 'admin-login' },
          DERIVED,
          { expiresIn: 300 },
        ),
    ],
    [
      'an access token (wrong key)',
      () => jsonwebtoken.sign({ sub: USER, email: 'e', sid: CID }, ACCESS),
    ],
    [
      'an expired challenge',
      () =>
        jsonwebtoken.sign(
          {
            sub: USER,
            cid: CID,
            purpose: 'mfa',
            exp: Math.floor(Date.now() / 1000) - 1,
          },
          DERIVED,
        ),
    ],
    ['garbage', () => 'not.a.jwt'],
    [
      'no cid',
      () =>
        jsonwebtoken.sign({ sub: USER, purpose: 'mfa' }, DERIVED, {
          expiresIn: 300,
        }),
    ],
  ])('open refuses %s with MFA_CHALLENGE_EXPIRED', async (_n, make) => {
    const { service } = build();
    expect(await codeOf(service.open(make()))).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('open refuses a token whose row is consumed or expired (no live row)', async () => {
    const { service } = build({ row: null });
    const token = jsonwebtoken.sign(
      { sub: USER, cid: CID, purpose: 'mfa' },
      DERIVED,
      { expiresIn: 300 },
    );
    expect(await codeOf(service.open(token))).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('with no access secret and no challenge secret, create throws (never signs with nothing)', async () => {
    const { service } = build({ secrets: {} });
    await expect(service.create(USER, null)).rejects.toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });
});
