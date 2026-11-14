/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- service doubles; jest.fn calls are untyped */
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/** What the duplicate check finds ([] = a new channel). */
let existing: Record<string, unknown>[];
/** Values handed to the insert, and to the reconnect update. */
let inserted: Record<string, unknown>[];
let updates: Record<string, unknown>[];

const chain = (rows: () => unknown[]) => {
  const p: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej),
    limit: () => chain(rows),
    orderBy: () => chain(rows),
    returning: () => chain(rows),
  };
  return p;
};

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  workspaceId: 'ws',
  platform: 'bluesky',
  category: 'social',
  accountType: 'profile',
  platformAccountId: 'acc',
  accountName: 'Bluesky',
  accessToken: 'enc',
  refreshToken: null,
  tokenExpiresAt: null,
  refreshTokenIssuedAt: null,
  isActive: true,
  pausedAt: null,
  pausedByUserId: null,
  connectionStatus: 'expired', // unhealthy -> reconnect path
  lastError: 'Token expired',
  metadata: {},
  connectedByUserId: 'u1',
  displayOrder: 1,
  connectLinkId: null,
  addedViaLinkAt: null,
  addedViaLinkEmail: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const mockDb = {
  select: jest.fn((fields?: unknown) => ({
    from: (table: unknown) => ({
      where: () =>
        chain(() => {
          if (table !== socialMediaChannels) return []; // users lookup
          // select({ maxOrder }) -> display order; select() -> duplicate check
          return fields ? [{ maxOrder: 1 }] : existing;
        }),
    }),
  })),
  update: jest.fn(() => ({
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return {
        // The row after the update: what was stored, plus what was written.
        where: () => chain(() => [{ ...(existing[0] ?? {}), ...v }]),
      };
    },
  })),
  insert: jest.fn(() => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return chain(() => [storedRow({ ...v, id: 9, isActive: true })]);
    },
  })),
  transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { ChannelService } from './channel.service';

function make() {
  const svc = new ChannelService(
    {} as never,
    { onChannelConnected: jest.fn(async () => undefined) } as never,
    {} as never,
    { ownerOf: jest.fn(async () => 'owner-1') } as never,
  );
  // Not under test here: the billing counter and the orphaned-target re-link.
  (svc as any).incrementChannelCount = jest.fn(async () => undefined);
  (svc as any).migrateOrphanedPostTargets = jest.fn(async () => undefined);
  return svc;
}

// Non-billable platform: the insert path then needs no account ceiling.
const dto = {
  platform: 'google_drive',
  accountType: 'storage',
  platformAccountId: 'acc',
  accountName: 'Drive',
  accessToken: 'tok',
} as const;

const bsky = {
  platform: 'bluesky',
  accountType: 'profile',
  platformAccountId: 'acc',
  accountName: 'Bluesky',
  accessToken: 'tok',
} as const;

beforeEach(() => {
  existing = [];
  inserted = [];
  updates = [];
});

describe('ChannelService.createChannel - link mark', () => {
  it('createChannel with connectLink writes the three columns', async () => {
    const before = Date.now();
    const out = await make().createChannel('ws', 'sender', dto, {
      connectLink: { linkId: 'link-1', email: 'client@example.com' },
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      connectLinkId: 'link-1',
      addedViaLinkEmail: 'client@example.com',
      connectedByUserId: 'sender',
    });
    const at = inserted[0].addedViaLinkAt as Date;
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(out.connectedVia).toEqual({
      kind: 'link',
      email: 'client@example.com',
    });
  });

  it('a link with no email stores null and still marks the channel', async () => {
    const out = await make().createChannel('ws', 'sender', dto, {
      connectLink: { linkId: 'link-1', email: null },
    });
    expect(inserted[0]).toMatchObject({
      connectLinkId: 'link-1',
      addedViaLinkEmail: null,
    });
    expect(inserted[0].addedViaLinkAt).toBeInstanceOf(Date);
    expect(out.connectedVia).toEqual({ kind: 'link', email: null });
  });

  it('createChannel without options writes none', async () => {
    const out = await make().createChannel('ws', 'u1', dto);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toHaveProperty('connectLinkId');
    expect(inserted[0]).not.toHaveProperty('addedViaLinkAt');
    expect(inserted[0]).not.toHaveProperty('addedViaLinkEmail');
    expect(out.connectedVia).toBeNull();
  });

  it('createChannel with empty options writes none', async () => {
    await make().createChannel('ws', 'u1', dto, {});
    expect(inserted[0]).not.toHaveProperty('connectLinkId');
  });

  it('reconnect of a link-added channel keeps its mark', async () => {
    const at = new Date('2026-11-01T00:00:00Z');
    existing = [
      storedRow({
        connectLinkId: 'link-1',
        addedViaLinkAt: at,
        addedViaLinkEmail: 'client@example.com',
      }),
    ];

    // Reconnected by a plain sign-in (no options), then through ANOTHER link.
    const svc = make();
    const first = await svc.createChannel('ws', 'u1', bsky);
    const second = await svc.createChannel('ws', 'sender', bsky, {
      connectLink: { linkId: 'link-2', email: 'other@example.com' },
    });

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u).not.toHaveProperty('connectLinkId');
      expect(u).not.toHaveProperty('addedViaLinkAt');
      expect(u).not.toHaveProperty('addedViaLinkEmail');
    }
    expect(inserted).toHaveLength(0);
    for (const out of [first, second]) {
      expect(out.connectedVia).toEqual({
        kind: 'link',
        email: 'client@example.com',
      });
    }
  });

  it('reconnect of a channel that was not link-added stays unmarked', async () => {
    existing = [storedRow()];
    const out = await make().createChannel('ws', 'sender', bsky, {
      connectLink: { linkId: 'link-2', email: 'x@example.com' },
    });
    expect(updates[0]).not.toHaveProperty('connectLinkId');
    expect(out.connectedVia).toBeNull();
  });
});
