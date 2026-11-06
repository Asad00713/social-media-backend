/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';
import { campaigns } from '../../../drizzle/schema/campaigns.schema';
import { DraftStoreService } from './draft-store.service';
import { ComposerSchedulingService } from './composer-scheduling.service';
import { PublishOrchestratorService } from './publish-orchestrator.service';

const WS = 'w1';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

/**
 * A db whose select answers by table: the post row for `posts`, and the
 * campaign lookup for `campaigns` (found or not).
 */
function fakeDb(existing: any[], campaignFound = true) {
  const writes: { inserted?: any; updated?: any; conflictSet?: any } = {};
  const stamp = { createdAt: new Date(), updatedAt: new Date() };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === campaigns
              ? campaignFound
                ? [{ id: C2 }]
                : []
              : existing,
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        writes.inserted = v;
        const p: any = Promise.resolve();
        p.returning = async () => [{ ...v, ...stamp }];
        p.onConflictDoUpdate = async (c: any) => {
          writes.conflictSet = c.set;
        };
        return p;
      },
    }),
    update: () => ({
      set: (v: any) => {
        writes.updated ??= v;
        const w: any = {
          returning: async () => [
            { id: 'd1', workspaceId: WS, ...v, ...stamp },
          ],
        };
        return { where: () => Object.assign(Promise.resolve(), w) };
      },
    }),
  };
  return { db, writes };
}

const base = { text: 't', mediaItems: [], hashtags: [], mentions: [] };
const stored = (meta: any) => [
  { id: 'd1', status: 'draft', createdById: 'u1', metadata: meta },
];

describe('Save draft files the post', () => {
  it('writes the campaign and labels it is sent', async () => {
    const { db, writes } = fakeDb([]);
    const draft = await new DraftStoreService(db).upsert(WS, 'u1', {
      draftId: 'd1',
      base,
      campaignId: C2,
      labels: [' Launch ', 'launch', 'Drinks'],
    } as any);
    expect(writes.inserted.metadata).toMatchObject({
      campaignId: C2,
      labels: ['Launch', 'Drinks'],
    });
    // …and hands them back, so the composer reopens with them.
    expect(draft.campaignId).toBe(C2);
    expect(draft.labels).toEqual(['Launch', 'Drinks']);
  });

  it('keeps them when a save does not send the keys', async () => {
    const { db, writes } = fakeDb(stored({ campaignId: C1, labels: ['A'] }));
    await new DraftStoreService(db).upsert(WS, 'u1', {
      draftId: 'd1',
      base,
    } as any);
    expect(writes.updated.metadata).toMatchObject({
      campaignId: C1,
      labels: ['A'],
    });
  });

  it('clears them on null and an empty list', async () => {
    const { db, writes } = fakeDb(stored({ campaignId: C1, labels: ['A'] }));
    await new DraftStoreService(db).upsert(WS, 'u1', {
      draftId: 'd1',
      base,
      campaignId: null,
      labels: [],
    } as any);
    expect(writes.updated.metadata).not.toHaveProperty('campaignId');
    expect(writes.updated.metadata).not.toHaveProperty('labels');
  });

  it('refuses a campaign from another workspace and writes nothing', async () => {
    const { db, writes } = fakeDb([], false);
    await expect(
      new DraftStoreService(db).upsert(WS, 'u1', {
        draftId: 'd1',
        base,
        campaignId: C2,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.inserted).toBeUndefined();
  });
});

describe('Schedule files the post', () => {
  function make(existing: any[], found = true) {
    const { db, writes } = fakeDb(existing, found);
    const svc = new ComposerSchedulingService(
      db as any,
      { getJob: jest.fn(async () => null), add: jest.fn() } as any,
      { syncPost: jest.fn(async () => undefined) } as any,
      { enforceQueueLimit: jest.fn(async () => undefined) } as any,
    );
    return { svc, writes };
  }
  const dto = (over: any = {}) => ({
    draftId: 'd1',
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    base,
    channels: [
      {
        channelId: '7',
        platform: 'facebook',
        publishStatus: 'queued',
        retryCount: 0,
      },
    ],
    ...over,
  });

  it('writes the campaign and labels', async () => {
    const { svc, writes } = make([]);
    await svc.schedule(WS, 'u1', dto({ campaignId: C2, labels: ['Launch'] }));
    expect(writes.inserted.metadata).toMatchObject({
      campaignId: C2,
      labels: ['Launch'],
    });
  });

  it('keeps a materialised post on its campaign slot when rescheduled', async () => {
    const slot = { date: '2026-11-10', channelId: '7' };
    const { svc, writes } = make(
      stored({ campaignId: C1, campaignSlot: slot }).map((r) => ({
        ...r,
        status: 'scheduled',
      })),
    );
    await svc.schedule(WS, 'u1', dto());
    expect(writes.updated.metadata).toMatchObject({
      campaignId: C1,
      campaignSlot: slot,
    });
  });

  it('refuses a campaign from another workspace', async () => {
    const { svc, writes } = make([], false);
    await expect(
      svc.schedule(WS, 'u1', dto({ campaignId: C2 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.inserted).toBeUndefined();
  });
});

describe('Publish files the post', () => {
  function make(existing: any[], found = true) {
    const { db, writes } = fakeDb(existing, found);
    const publisher = {
      publish: jest.fn(async () => ({
        success: true,
        platformPostId: 'p1',
        platformPostUrl: 'https://x/p1',
      })),
    };
    const svc = new PublishOrchestratorService(
      { resolve: jest.fn(() => ({ platformSpecific: {} })) } as any,
      { map: jest.fn() } as any,
      { getPublisher: jest.fn(() => publisher) } as any,
      { emit: jest.fn() } as any,
      {
        getCredentials: jest.fn(async () => ({
          accessToken: 't',
          platformAccountId: 'a',
          channelMetadata: {},
        })),
      } as any,
      db as any,
      { send: jest.fn() } as any, // PostReminderService
    );
    return { svc, writes };
  }
  const input = (over: any = {}) => ({
    draftId: 'd1',
    base,
    channels: [
      {
        channelId: '7',
        platform: 'facebook',
        publishStatus: 'queued',
        retryCount: 0,
      },
    ],
    ...over,
  });

  it('writes the campaign and labels on insert and on conflict', async () => {
    const { svc, writes } = make([]);
    await svc.publishInline(WS, 'u1', input({ campaignId: C2, labels: ['A'] }));
    expect(writes.inserted.metadata).toMatchObject({
      campaignId: C2,
      labels: ['A'],
    });
    expect(writes.conflictSet.metadata).toMatchObject({
      campaignId: C2,
      labels: ['A'],
    });
  });

  it('keeps the stored filing when the publish does not send it', async () => {
    const { svc, writes } = make(stored({ campaignId: C1, labels: ['B'] }));
    await svc.publishInline(WS, 'u1', input());
    expect(writes.conflictSet.metadata).toMatchObject({
      campaignId: C1,
      labels: ['B'],
    });
  });

  it('refuses a campaign from another workspace before publishing', async () => {
    const { svc, writes } = make([], false);
    await expect(
      svc.publishInline(WS, 'u1', input({ campaignId: C2 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.inserted).toBeUndefined();
  });
});
