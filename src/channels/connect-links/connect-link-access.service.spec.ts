import { HttpException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbType } from '../../drizzle/db';
import { subscriptions } from '../../drizzle/schema/billing.schema';
import { channelConnectLinks } from '../../drizzle/schema/channel-connect-links.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import type { WorkspaceRole } from '../../workspace-members/role-capabilities';
import type { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import type { OAuthService } from '../services/oauth.service';
import { ConnectLinkAccessService } from './connect-link-access.service';
import { encrypt } from '../../common/utils/encryption.util';
import { CONNECT_LINK_TTL_MS, hashLinkToken } from './lib/connect-link-rules';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const USER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const BASE = new Date('2026-11-13T10:00:00Z');

type Row = Record<string, unknown>;

/**
 * `select().from(table)` resolves to the rows given for that table that satisfy
 * the `eq(column, value)` conditions of the query's `where()`. The predicate is
 * compiled to SQL with the real dialect and read back, so a lookup that stops
 * filtering on a column (token hash, link id, workspace id) returns extra rows
 * here and the test fails, instead of the fake quietly ignoring it.
 */
function fakeDb(tables: Map<unknown, Row[]>) {
  const dialect = new PgDialect();
  const camel = (col: string) =>
    col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const chain = (rows: Row[]) => {
    let condition: SQL | undefined;
    const c: Record<string, unknown> = {};
    c.where = (cond: SQL) => {
      condition = cond;
      return c;
    };
    for (const m of ['orderBy', 'limit']) c[m] = () => c;
    c.then = (resolve: (r: Row[]) => unknown) => {
      if (!condition) return resolve(rows);
      const { sql, params } = dialect.sqlToQuery(condition);
      const eqs = [...sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)].map((m) => ({
        field: camel(m[2]),
        value: params[Number(m[3]) - 1],
      }));
      return resolve(
        rows.filter((r) => eqs.every((e) => r[e.field] === e.value)),
      );
    };
    return c;
  };
  return {
    select: () => ({ from: (t: unknown) => chain(tables.get(t) ?? []) }),
  } as unknown as DbType;
}

function linkRow(over: Row = {}): Row {
  return {
    id: LINK,
    workspaceId: WS,
    createdByUserId: USER,
    email: 'client@example.com',
    networks: ['instagram', 'facebook'],
    tokenHash: hashLinkToken('t'),
    tokenEncrypted: 'x',
    expiresAt: new Date(BASE.getTime() + CONNECT_LINK_TTL_MS),
    revokedAt: null,
    lastSentAt: null,
    createdAt: BASE,
    updatedAt: BASE,
    ...over,
  };
}

interface Opts {
  link?: Row | null;
  workspaceRow?: Row | null;
  subscription?: Row | null;
  role?: WorkspaceRole | null;
  channels?: Row[];
  sender?: Row | null;
}

function setup(opts: Opts = {}) {
  const tables = new Map<unknown, Row[]>([
    [
      channelConnectLinks,
      opts.link === null ? [] : [{ ...linkRow(), ...(opts.link ?? {}) }],
    ],
    [
      workspace,
      opts.workspaceRow === null
        ? []
        : [
            {
              id: WS,
              name: 'Acme Agency',
              ownerId: OWNER,
              isActive: true,
              ...(opts.workspaceRow ?? {}),
            },
          ],
    ],
    [
      subscriptions,
      opts.subscription ? [{ userId: OWNER, ...opts.subscription }] : [],
    ],
    [
      socialMediaChannels,
      (opts.channels ?? []).map((c) => ({
        workspaceId: WS,
        connectLinkId: LINK,
        ...c,
      })),
    ],
    [
      users,
      opts.sender === null
        ? []
        : [
            {
              id: USER,
              name: 'Sam Sender',
              email: 'sam@agency.test',
              ...(opts.sender ?? {}),
            },
          ],
    ],
  ]);
  const getRole = jest.fn(() =>
    Promise.resolve(opts.role === undefined ? 'MEMBER' : opts.role),
  );
  const initiateOAuth = jest.fn(() =>
    Promise.resolve({
      authorizationUrl: 'https://network.test/auth',
      state: 'secret-state',
      expiresAt: new Date(),
    }),
  );
  const service = new ConnectLinkAccessService(
    fakeDb(tables),
    { getRole } as unknown as WorkspaceRoleService,
    { initiateOAuth } as unknown as OAuthService,
  );
  return { service, getRole, initiateOAuth };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return ((e as HttpException).getResponse() as { code?: string }).code;
  }
  return undefined;
}

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as HttpException).getStatus();
  }
  return undefined;
}

describe('ConnectLinkAccessService', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(BASE);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('resolve', () => {
    it('an unknown token -> LINK_NOT_FOUND (404)', async () => {
      const { service } = setup({ link: null });
      expect(await codeOf(service.resolve('nope'))).toBe('LINK_NOT_FOUND');
      expect(await statusOf(service.resolve('nope'))).toBe(404);
    });

    it('looks the link up by the hash of the token, not by anything else', async () => {
      // the row is stored under hash('t'); only that raw token finds it
      const { service } = setup();
      await expect(service.resolve('t')).resolves.toBeDefined();
      expect(await codeOf(service.resolve('T'))).toBe('LINK_NOT_FOUND');
      // the hash itself is not a token: presenting it finds nothing
      expect(await codeOf(service.resolve(hashLinkToken('t')))).toBe(
        'LINK_NOT_FOUND',
      );
    });

    it('a revoked link -> LINK_REVOKED (410)', async () => {
      const { service } = setup({ link: { revokedAt: BASE } });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_REVOKED');
      expect(await statusOf(service.resolve('t'))).toBe(410);
    });

    it('an expired link -> LINK_EXPIRED (410)', async () => {
      const { service } = setup({
        link: { expiresAt: new Date(BASE.getTime() - 1) },
      });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_EXPIRED');
      expect(await statusOf(service.resolve('t'))).toBe(410);
    });

    it('revoked wins over expired', async () => {
      const { service } = setup({
        link: { revokedAt: BASE, expiresAt: new Date(BASE.getTime() - 1) },
      });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_REVOKED');
    });

    it('a manually suspended workspace -> LINK_UNAVAILABLE (410)', async () => {
      const { service } = setup({ workspaceRow: { isActive: false } });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_UNAVAILABLE');
      expect(await statusOf(service.resolve('t'))).toBe(410);
    });

    it('a billing-suspended workspace -> LINK_UNAVAILABLE', async () => {
      const { service } = setup({ subscription: { status: 'unpaid' } });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_UNAVAILABLE');
    });

    it('a past_due workspace is still usable (soft state)', async () => {
      const { service } = setup({ subscription: { status: 'past_due' } });
      await expect(service.resolve('t')).resolves.toBeDefined();
    });

    it('a missing workspace -> LINK_UNAVAILABLE', async () => {
      const { service } = setup({ workspaceRow: null });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_UNAVAILABLE');
    });

    it('sender without channels:manage -> LINK_UNAVAILABLE', async () => {
      const { service } = setup({ role: 'GUEST' });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_UNAVAILABLE');
    });

    it('sender no longer a member -> LINK_UNAVAILABLE', async () => {
      const { service } = setup({ role: null });
      expect(await codeOf(service.resolve('t'))).toBe('LINK_UNAVAILABLE');
    });

    it('owner always allowed', async () => {
      const { service, getRole } = setup({ role: 'OWNER' });
      await expect(service.resolve('t')).resolves.toBeDefined();
      expect(getRole).toHaveBeenCalledWith(WS, USER);
    });

    it.each(['MEMBER', 'ADMIN'] as const)(
      'a %s sender is allowed',
      async (r) => {
        const { service } = setup({ role: r });
        await expect(service.resolve('t')).resolves.toBeDefined();
      },
    );

    it('returns the link, workspace and sender', async () => {
      const { service } = setup();
      const res = await service.resolve('t');
      expect(res.link.id).toBe(LINK);
      expect(res.workspace).toEqual({ id: WS, name: 'Acme Agency' });
      expect(res.sender).toEqual({
        id: USER,
        name: 'Sam Sender',
        email: 'sam@agency.test',
      });
    });
  });

  describe('resolveById', () => {
    it('applies the same checks as resolve', async () => {
      expect(
        await codeOf(setup({ link: null }).service.resolveById(LINK)),
      ).toBe('LINK_NOT_FOUND');
      expect(
        await codeOf(
          setup({ link: { revokedAt: BASE } }).service.resolveById(LINK),
        ),
      ).toBe('LINK_REVOKED');
      expect(
        await codeOf(
          setup({
            link: { expiresAt: new Date(BASE.getTime() - 1) },
          }).service.resolveById(LINK),
        ),
      ).toBe('LINK_EXPIRED');
      expect(
        await codeOf(setup({ role: 'GUEST' }).service.resolveById(LINK)),
      ).toBe('LINK_UNAVAILABLE');
      await expect(setup().service.resolveById(LINK)).resolves.toBeDefined();
    });
  });

  describe('linkOfState', () => {
    const OWN = { workspaceId: WS, userId: USER };
    const OTHER_WS = '66666666-6666-4666-8666-666666666666';
    const OTHER_USER = '77777777-7777-4777-8777-777777777777';

    it("decrypts the link's token whatever its status (the callback must reach /c/<token>)", async () => {
      const tokenEncrypted = encrypt('the-raw-token');
      expect(
        await setup({ link: { tokenEncrypted } }).service.linkOfState(
          LINK,
          OWN,
        ),
      ).toEqual({ status: 'own', rawToken: 'the-raw-token' });
      expect(
        await setup({
          link: { tokenEncrypted, revokedAt: BASE },
        }).service.linkOfState(LINK, OWN),
      ).toEqual({ status: 'own', rawToken: 'the-raw-token' });
    });

    it('looks the link up by id: another id finds nothing', async () => {
      const { service } = setup({
        link: { tokenEncrypted: encrypt('the-raw-token') },
      });
      expect(
        await service.linkOfState('99999999-9999-4999-8999-999999999999', OWN),
      ).toEqual({ status: 'missing' });
    });

    it('a missing link -> missing; an unreadable token -> own without a token', async () => {
      expect(
        await setup({ link: null }).service.linkOfState(LINK, OWN),
      ).toEqual({ status: 'missing' });
      // a corrupt ciphertext (decrypt throws) is not a token
      expect(
        await setup({
          link: { tokenEncrypted: 'not:a-ciphertext' },
        }).service.linkOfState(LINK, OWN),
      ).toEqual({ status: 'own', rawToken: null });
    });

    it("a state of another workspace is not the link's: foreign, and no token", async () => {
      const { service } = setup({
        link: { tokenEncrypted: encrypt('the-raw-token') },
      });
      const out = await service.linkOfState(LINK, {
        workspaceId: OTHER_WS,
        userId: USER,
      });
      expect(out).toEqual({ status: 'foreign' });
      expect(JSON.stringify(out)).not.toContain('the-raw-token');
    });

    it("a state of another user in the link's workspace is foreign too", async () => {
      const { service } = setup({
        link: { tokenEncrypted: encrypt('the-raw-token') },
      });
      expect(
        await service.linkOfState(LINK, {
          workspaceId: WS,
          userId: OTHER_USER,
        }),
      ).toEqual({ status: 'foreign' });
    });
  });

  describe('preview', () => {
    it('returns only workspace name, sender and networks (keys exact)', async () => {
      const { service } = setup({
        channels: [
          {
            platform: 'instagram',
            accountName: '@acme',
            profilePictureUrl: 'https://cdn.test/a.png',
            id: 99,
            workspaceId: WS,
            addedViaLinkEmail: 'client@example.com',
          },
        ],
      });
      const res = await service.preview('t');
      expect(Object.keys(res).sort()).toEqual([
        'expiresAt',
        'networks',
        'sender',
        'workspaceName',
      ]);
      expect(Object.keys(res.sender).sort()).toEqual(['email', 'name']);
      for (const n of res.networks) {
        expect(Object.keys(n).sort()).toEqual(['connected', 'platform']);
        for (const c of n.connected) {
          expect(Object.keys(c).sort()).toEqual(['accountName', 'avatarUrl']);
        }
      }
      const json = JSON.stringify(res);
      expect(json).not.toContain(WS);
      expect(json).not.toContain('client@example.com');
      expect(json).not.toContain(OWNER);
    });

    it('lists accounts under the platform they belong to, and offered networks without any as empty', async () => {
      const { service } = setup({
        channels: [
          {
            platform: 'instagram',
            accountName: '@acme',
            profilePictureUrl: 'https://cdn.test/a.png',
          },
          {
            platform: 'instagram',
            accountName: '@acme.two',
            profilePictureUrl: null,
          },
        ],
      });
      const res = await service.preview('t');
      expect(res.workspaceName).toBe('Acme Agency');
      expect(res.sender).toEqual({
        name: 'Sam Sender',
        email: 'sam@agency.test',
      });
      expect(res.expiresAt).toBe(
        new Date(BASE.getTime() + CONNECT_LINK_TTL_MS).toISOString(),
      );
      expect(res.networks).toEqual([
        {
          platform: 'instagram',
          connected: [
            { accountName: '@acme', avatarUrl: 'https://cdn.test/a.png' },
            { accountName: '@acme.two', avatarUrl: null },
          ],
        },
        { platform: 'facebook', connected: [] },
      ]);
    });

    it('never lists a channel of another link or another workspace', async () => {
      const OTHER_LINK = '55555555-5555-4555-8555-555555555555';
      const OTHER_WS = '66666666-6666-4666-8666-666666666666';
      const { service } = setup({
        channels: [
          { platform: 'instagram', accountName: '@mine' },
          {
            platform: 'instagram',
            accountName: '@other-link',
            connectLinkId: OTHER_LINK,
          },
          {
            platform: 'instagram',
            accountName: '@other-workspace',
            workspaceId: OTHER_WS,
          },
          {
            platform: 'facebook',
            accountName: '@added-by-hand',
            connectLinkId: null,
          },
        ],
      });
      const res = await service.preview('t');
      const names = res.networks.flatMap((n) =>
        n.connected.map((c) => c.accountName),
      );
      expect(names).toEqual(['@mine']);
    });

    it('a dead link previews as its error', async () => {
      const { service } = setup({ link: { revokedAt: BASE } });
      expect(await codeOf(service.preview('t'))).toBe('LINK_REVOKED');
    });
  });

  describe('start', () => {
    it('a platform the link does not offer -> NETWORK_NOT_OFFERED (400)', async () => {
      const { service, initiateOAuth } = setup();
      expect(await codeOf(service.start('t', 'tiktok'))).toBe(
        'NETWORK_NOT_OFFERED',
      );
      expect(await statusOf(service.start('t', 'tiktok'))).toBe(400);
      expect(await codeOf(service.start('t', 'bluesky'))).toBe(
        'NETWORK_NOT_OFFERED',
      );
      expect(initiateOAuth).not.toHaveBeenCalled();
    });

    it('a dead link never reaches the network', async () => {
      const { service, initiateOAuth } = setup({ role: 'GUEST' });
      expect(await codeOf(service.start('t', 'instagram'))).toBe(
        'LINK_UNAVAILABLE',
      );
      expect(initiateOAuth).not.toHaveBeenCalled();
    });

    it('start passes connectLinkId and the sender id to initiateOAuth', async () => {
      const { service, initiateOAuth } = setup();
      const res = await service.start('t', 'instagram');
      expect(initiateOAuth).toHaveBeenCalledWith(WS, USER, {
        platform: 'instagram',
        additionalData: { connectLinkId: LINK, intent: 'connect' },
      });
      // only the URL goes back: not the state, not the expiry
      expect(res).toEqual({ authorizationUrl: 'https://network.test/auth' });
    });
  });
});
