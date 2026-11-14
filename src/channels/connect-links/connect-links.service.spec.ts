import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import { decrypt, hash } from '../../common/utils/encryption.util';
import { channelConnectLinks } from '../../drizzle/schema/channel-connect-links.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import type { DbType } from '../../drizzle/db';
import type { EmailService } from '../../email/email.service';
import { ConnectLinksService } from './connect-links.service';
import { CONNECT_LINK_TTL_MS, createLinkToken } from './lib/connect-link-rules';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const BASE = new Date('2026-11-13T10:00:00Z');

type Row = Record<string, unknown>;

/**
 * A chainable drizzle stand-in. `select().from(table)` resolves to the rows
 * given for that table; insert / update record what they were given and
 * resolve to the configured rows.
 */
function fakeDb(
  tables: Map<unknown, Row[]>,
  updateRows: () => Row[] = () => [],
) {
  const inserted: Row[] = [];
  const updates: Row[] = [];
  const chain = (rows: () => Row[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'limit', 'returning', 'from']) {
      c[m] = () => c;
    }
    c.then = (resolve: (r: Row[]) => unknown) => resolve(rows());
    return c;
  };
  const db = {
    select: () => ({
      from: (t: unknown) => chain(() => tables.get(t) ?? []),
    }),
    insert: () => ({
      values: (v: Row) => {
        inserted.push(v);
        return chain(() => [
          {
            id: LINK,
            createdAt: BASE,
            lastSentAt: null,
            revokedAt: null,
            ...v,
          },
        ]);
      },
    }),
    update: () => ({
      set: (s: Row) => {
        updates.push(s);
        return chain(updateRows);
      },
    }),
  };
  return { db: db as unknown as DbType, inserted, updates };
}

function linkRow(over: Row = {}): Row {
  return {
    id: LINK,
    workspaceId: WS,
    createdByUserId: USER,
    email: 'client@example.com',
    networks: ['instagram', 'facebook'],
    tokenHash: 'x',
    tokenEncrypted: 'x',
    expiresAt: new Date(BASE.getTime() + CONNECT_LINK_TTL_MS),
    revokedAt: null,
    lastSentAt: null,
    createdAt: BASE,
    updatedAt: BASE,
    ...over,
  };
}

const sender = {
  id: USER,
  name: 'Sam Sender',
  email: 'sam@agency.test',
  avatarUrl: null,
};

function setup(
  opts: { links?: Row[]; channels?: Row[]; updateRows?: Row[] } = {},
) {
  const tables = new Map<unknown, Row[]>([
    [channelConnectLinks, opts.links ?? []],
    [socialMediaChannels, opts.channels ?? []],
    [users, [sender]],
    [workspace, [{ id: WS, name: 'Acme Agency' }]],
  ]);
  const { db, inserted, updates } = fakeDb(tables, () => opts.updateRows ?? []);
  const email = {
    sendChannelConnectLink: jest.fn(() => Promise.resolve({ success: true })),
  };
  const service = new ConnectLinksService(db, email as unknown as EmailService);
  return { service, email, inserted, updates, db };
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

function storedLink(over: Row = {}) {
  const token = createLinkToken();
  return {
    token,
    row: linkRow({
      tokenHash: token.hash,
      tokenEncrypted: token.encrypted,
      ...over,
    }),
  };
}

describe('ConnectLinksService', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
    process.env.FRONTEND_URL = 'https://app.test';
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

  describe('create', () => {
    it('send:true with no email -> NO_EMAIL', async () => {
      const { service, email } = setup();
      const code = await codeOf(
        service.create(WS, USER, { networks: ['instagram'], send: true }),
      );
      expect(code).toBe('NO_EMAIL');
      expect(email.sendChannelConnectLink).not.toHaveBeenCalled();
    });

    it('a network the link cannot offer -> NETWORK_NOT_OFFERED', async () => {
      const { service, inserted } = setup();
      const code = await codeOf(
        service.create(WS, USER, {
          networks: ['instagram', 'bluesky'],
          send: false,
        }),
      );
      expect(code).toBe('NETWORK_NOT_OFFERED');
      expect(inserted).toHaveLength(0);
    });

    it('stores the hash and the encrypted token, never the raw one, and returns a url ending in it', async () => {
      const { service, inserted } = setup();
      const res = await service.create(WS, USER, {
        networks: ['instagram'],
        send: false,
      });
      const raw = res.url.slice('https://app.test/c/'.length);
      expect(raw).toHaveLength(43);
      const row = inserted[0];
      expect(row.tokenHash).toBe(hash(raw));
      expect(decrypt(row.tokenEncrypted as string)).toBe(raw);
      expect(JSON.stringify(row)).not.toContain(raw);
      expect(row.expiresAt).toEqual(
        new Date(BASE.getTime() + CONNECT_LINK_TTL_MS),
      );
      expect(row.workspaceId).toBe(WS);
      expect(row.createdByUserId).toBe(USER);
      expect(row.email).toBeNull();
    });

    it('send:true emails once and stamps lastSentAt', async () => {
      const { service, email, inserted } = setup();
      const res = await service.create(WS, USER, {
        email: 'client@example.com',
        networks: ['instagram', 'facebook'],
        send: true,
      });
      expect(email.sendChannelConnectLink).toHaveBeenCalledTimes(1);
      expect(email.sendChannelConnectLink).toHaveBeenCalledWith(
        'client@example.com',
        expect.objectContaining({
          workspaceName: 'Acme Agency',
          senderName: 'Sam Sender',
          networks: ['instagram', 'facebook'],
          url: res.url,
          expiresAt: new Date(BASE.getTime() + CONNECT_LINK_TTL_MS),
        }),
      );
      expect(inserted[0].lastSentAt).toEqual(BASE);
      expect(res.link.lastSentAt).toBe(BASE.toISOString());
    });

    it('send:false keeps the email on the link and sends nothing', async () => {
      const { service, email, inserted } = setup();
      await service.create(WS, USER, {
        email: 'client@example.com',
        networks: ['instagram'],
        send: false,
      });
      expect(email.sendChannelConnectLink).not.toHaveBeenCalled();
      expect(inserted[0].email).toBe('client@example.com');
      expect(inserted[0].lastSentAt).toBeNull();
    });

    it('a failed email creates no link', async () => {
      const { service, email, inserted } = setup();
      email.sendChannelConnectLink.mockResolvedValueOnce({ success: false });
      const code = await codeOf(
        service.create(WS, USER, {
          email: 'client@example.com',
          networks: ['instagram'],
          send: true,
        }),
      );
      expect(code).toBe('EMAIL_SEND_FAILED');
      expect(inserted).toHaveLength(0);
    });
  });

  describe('resend', () => {
    it('within 60 s of the last send -> RESEND_TOO_SOON', async () => {
      const { row } = storedLink({
        lastSentAt: new Date(BASE.getTime() - 30_000),
      });
      // the conditional claim matches no row while the cool-down is running
      const { service, email } = setup({ links: [row], updateRows: [] });
      expect(await codeOf(service.resend(WS, LINK))).toBe('RESEND_TOO_SOON');
      expect(email.sendChannelConnectLink).not.toHaveBeenCalled();
    });

    it('a link without an email -> NO_EMAIL', async () => {
      const { row } = storedLink({ email: null });
      const { service } = setup({ links: [row] });
      expect(await codeOf(service.resend(WS, LINK))).toBe('NO_EMAIL');
    });

    it('a revoked or expired link cannot be resent', async () => {
      const revoked = storedLink({ revokedAt: BASE }).row;
      expect(
        await codeOf(setup({ links: [revoked] }).service.resend(WS, LINK)),
      ).toBe('LINK_REVOKED');
      const expired = storedLink({
        expiresAt: new Date(BASE.getTime() - 1),
      }).row;
      expect(
        await codeOf(setup({ links: [expired] }).service.resend(WS, LINK)),
      ).toBe('LINK_EXPIRED');
    });

    it('uses the same url as create, and does not move the expiry', async () => {
      const { row, token } = storedLink();
      const { service, email, updates } = setup({
        links: [row],
        updateRows: [{ ...row, lastSentAt: BASE }],
      });
      const res = await service.resend(WS, LINK);
      expect(email.sendChannelConnectLink).toHaveBeenCalledWith(
        'client@example.com',
        expect.objectContaining({
          url: `https://app.test/c/${token.raw}`,
          expiresAt: row.expiresAt,
        }),
      );
      expect(updates[0]).toEqual(expect.objectContaining({ lastSentAt: BASE }));
      expect(updates[0]).not.toHaveProperty('expiresAt');
      expect(res.link.lastSentAt).toBe(BASE.toISOString());
    });

    it('a failed email gives the cool-down back', async () => {
      const { row } = storedLink();
      const { service, email, updates } = setup({
        links: [row],
        updateRows: [{ ...row, lastSentAt: BASE }],
      });
      email.sendChannelConnectLink.mockResolvedValueOnce({ success: false });
      expect(await codeOf(service.resend(WS, LINK))).toBe('EMAIL_SEND_FAILED');
      expect(updates).toHaveLength(2);
      expect(updates[1]).toEqual(expect.objectContaining({ lastSentAt: null }));
    });

    it('a failed rollback is logged and does not mask the send failure', async () => {
      const { row } = storedLink();
      const { service, email, db } = setup({
        links: [row],
        updateRows: [{ ...row, lastSentAt: BASE }],
      });
      email.sendChannelConnectLink.mockResolvedValueOnce({ success: false });
      // the claim update works, the give-back update fails
      const fake = db as unknown as { update: (t: unknown) => unknown };
      const realUpdate = fake.update;
      let calls = 0;
      fake.update = (t: unknown) => {
        calls += 1;
        if (calls === 2) throw new Error('db went away');
        return realUpdate(t);
      };
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(await codeOf(service.resend(WS, LINK))).toBe(
          'EMAIL_SEND_FAILED',
        );
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining('db went away'),
        );
      } finally {
        errorLog.mockRestore();
      }
    });

    it('a link of another workspace -> 404', async () => {
      const { service } = setup({ links: [] });
      await expect(service.resend(WS, LINK)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('revoke', () => {
    it('revoking twice keeps the first revokedAt', async () => {
      const first = new Date(BASE.getTime() - 3600_000);
      const { service, updates } = setup({
        links: [linkRow({ revokedAt: first })],
      });
      const res = await service.revoke(WS, LINK);
      expect(updates).toHaveLength(0);
      expect(res.link.status).toBe('revoked');
    });

    it('revokes an open link', async () => {
      const { service, updates } = setup({
        links: [linkRow()],
        updateRows: [linkRow({ revokedAt: BASE })],
      });
      const res = await service.revoke(WS, LINK);
      expect(updates[0]).toEqual(expect.objectContaining({ revokedAt: BASE }));
      expect(res.link.status).toBe('revoked');
    });
  });

  describe('list', () => {
    it('omits revoked and expired links', async () => {
      const open = linkRow({ id: 'open' });
      const revoked = linkRow({ id: 'revoked', revokedAt: BASE });
      const expired = linkRow({
        id: 'expired',
        expiresAt: new Date(BASE.getTime() - 1),
      });
      const { service } = setup({ links: [open, revoked, expired] });
      const res = await service.list(WS);
      expect(res.map((l) => l.id)).toEqual(['open']);
    });

    it('lists the accounts connected through each link', async () => {
      const { service } = setup({
        links: [linkRow()],
        channels: [
          {
            id: 9,
            platform: 'instagram',
            accountName: 'acme',
            profilePictureUrl: 'https://cdn.test/a.png',
            connectLinkId: LINK,
            addedViaLinkAt: BASE,
          },
        ],
      });
      const [dto] = await service.list(WS);
      expect(dto.createdBy).toEqual({
        id: USER,
        name: 'Sam Sender',
        avatarUrl: null,
      });
      expect(dto.connected).toEqual([
        {
          platform: 'instagram',
          channelId: 9,
          accountName: 'acme',
          avatarUrl: 'https://cdn.test/a.png',
          connectedAt: BASE.toISOString(),
        },
      ]);
    });
  });

  describe('get', () => {
    it('returns the same url create did', async () => {
      const { service: creator, inserted } = setup();
      const created = await creator.create(WS, USER, {
        networks: ['instagram'],
        send: false,
      });
      const { service } = setup({
        links: [
          linkRow({
            tokenHash: inserted[0].tokenHash,
            tokenEncrypted: inserted[0].tokenEncrypted,
          }),
        ],
      });
      const got = await service.get(WS, LINK);
      expect(got.url).toBe(created.url);
    });

    it('a link of another workspace -> 404', async () => {
      const { service } = setup({ links: [] });
      await expect(service.get(WS, LINK)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
