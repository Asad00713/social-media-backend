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

/** PostLabelsService double: records writes, answers reads from `names`. */
function fakeLabels(names: Record<string, string[]> = {}) {
  return {
    setForPost: jest.fn(async () => undefined),
    namesForPosts: jest.fn(
      async (ids: string[]) =>
        new Map(ids.filter((id) => names[id]).map((id) => [id, names[id]])),
    ),
  };
}

describe('Save draft files the post', () => {
  it('writes the campaign to metadata and the labels through post_labels', async () => {
    const { db, writes } = fakeDb([]);
    const labels = fakeLabels({ d1: ['Drinks', 'Launch'] });
    const draft = await new DraftStoreService(
      db,
      undefined,
      labels as any,
    ).upsert(WS, 'u1', {
      draftId: 'd1',
      base,
      campaignId: C2,
      labels: [' Launch ', 'launch', 'Drinks'],
    } as any);
    expect(writes.inserted.metadata).toMatchObject({ campaignId: C2 });
    expect(writes.inserted.metadata).not.toHaveProperty('labels');
    expect(labels.setForPost).toHaveBeenCalledTimes(1);
    expect(labels.setForPost).toHaveBeenCalledWith(WS, 'd1', [
      ' Launch ',
      'launch',
      'Drinks',
    ]);
    // ...and hands back what is stored, so the composer reopens with them.
    expect(draft.campaignId).toBe(C2);
    expect(draft.labels).toEqual(['Drinks', 'Launch']);
  });

  it('keeps the campaign and does not touch labels when a save does not send the keys', async () => {
    const { db, writes } = fakeDb(stored({ campaignId: C1, labels: ['A'] }));
    const labels = fakeLabels({ d1: ['A'] });
    const draft = await new DraftStoreService(
      db,
      undefined,
      labels as any,
    ).upsert(WS, 'u1', { draftId: 'd1', base } as any);
    expect(writes.updated.metadata).toMatchObject({ campaignId: C1 });
    expect(writes.updated.metadata).not.toHaveProperty('labels');
    expect(labels.setForPost).not.toHaveBeenCalled();
    expect(draft.labels).toEqual(['A']);
  });

  it('clears the campaign on null and the labels on an empty list (or null)', async () => {
    for (const cleared of [[], null]) {
      const { db, writes } = fakeDb(stored({ campaignId: C1, labels: ['A'] }));
      const labels = fakeLabels();
      await new DraftStoreService(db, undefined, labels as any).upsert(
        WS,
        'u1',
        { draftId: 'd1', base, campaignId: null, labels: cleared } as any,
      );
      expect(writes.updated.metadata).not.toHaveProperty('campaignId');
      expect(labels.setForPost).toHaveBeenCalledWith(WS, 'd1', []);
    }
  });

  it('refuses a campaign from another workspace and writes nothing', async () => {
    const { db, writes } = fakeDb([], false);
    const labels = fakeLabels();
    await expect(
      new DraftStoreService(db, undefined, labels as any).upsert(WS, 'u1', {
        draftId: 'd1',
        base,
        campaignId: C2,
        labels: ['A'],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.inserted).toBeUndefined();
    expect(labels.setForPost).not.toHaveBeenCalled();
  });

  it('reads labels in one batch for a list of drafts', async () => {
    const rows = [
      { id: 'd1', workspaceId: WS, metadata: {} },
      { id: 'd2', workspaceId: WS, metadata: { labels: ['Stale'] } },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
        }),
      }),
    };
    const labels = fakeLabels({ d2: ['Live'] });
    const list = await new DraftStoreService(
      db,
      undefined,
      labels as any,
    ).listDrafts(WS);
    expect(labels.namesForPosts).toHaveBeenCalledTimes(1);
    expect(labels.namesForPosts).toHaveBeenCalledWith(['d1', 'd2']);
    expect(list.map((d) => d.labels)).toEqual([[], ['Live']]);
  });
});

describe('Schedule files the post', () => {
  function make(existing: any[], found = true, names = {}) {
    const { db, writes } = fakeDb(existing, found);
    const labels = fakeLabels(names);
    const svc = new ComposerSchedulingService(
      db as any,
      { getJob: jest.fn(async () => null), add: jest.fn() } as any,
      { syncPost: jest.fn(async () => undefined) } as any,
      { enforceQueueLimit: jest.fn(async () => undefined) } as any,
      undefined,
      labels as any,
    );
    return { svc, writes, labels };
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

  it('writes the campaign and sets the labels', async () => {
    const { svc, writes, labels } = make([]);
    await svc.schedule(WS, 'u1', dto({ campaignId: C2, labels: ['Launch'] }));
    expect(writes.inserted.metadata).toMatchObject({ campaignId: C2 });
    expect(writes.inserted.metadata).not.toHaveProperty('labels');
    expect(labels.setForPost).toHaveBeenCalledTimes(1);
    expect(labels.setForPost).toHaveBeenCalledWith(WS, 'd1', ['Launch']);
  });

  it('does not touch labels when the schedule does not send them', async () => {
    const { svc, labels } = make([]);
    await svc.schedule(WS, 'u1', dto());
    expect(labels.setForPost).not.toHaveBeenCalled();
  });

  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const split = (over: any = {}) =>
    dto({
      scheduleMode: 'per_channel',
      channels: [
        { channelId: '7', platform: 'facebook', scheduleAt: at(1) },
        { channelId: '8', platform: 'twitter', scheduleAt: at(2) },
        { channelId: '9', platform: 'linkedin', scheduleAt: at(3) },
      ],
      ...over,
    });

  it('a split schedule sets the labels on every sibling, once each', async () => {
    const { svc, labels } = make([]);
    const result = await svc.schedule(WS, 'u1', split({ labels: ['Launch'] }));
    const ids = result.siblings!.map((s) => s.postId);
    expect(ids).toHaveLength(3);
    expect(labels.setForPost).toHaveBeenCalledTimes(3);
    for (const id of ids) {
      expect(labels.setForPost).toHaveBeenCalledWith(WS, id, ['Launch']);
    }
  });

  it("a split without labels copies the draft's stored labels to the new siblings only", async () => {
    const { svc, labels } = make(stored({}), true, { d1: ['Kept'] });
    const result = await svc.schedule(WS, 'u1', split());
    const newIds = result.siblings!.map((s) => s.postId).slice(1);
    expect(labels.namesForPosts).toHaveBeenCalledWith(['d1']);
    expect(labels.setForPost).toHaveBeenCalledTimes(2);
    for (const id of newIds) {
      expect(labels.setForPost).toHaveBeenCalledWith(WS, id, ['Kept']);
    }
    expect(labels.setForPost).not.toHaveBeenCalledWith(
      WS,
      'd1',
      expect.anything(),
    );
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
    const labels = fakeLabels();
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
      labels as any,
    );
    return { svc, writes, labels };
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

  it('writes the campaign on insert and on conflict, and sets the labels', async () => {
    const { svc, writes, labels } = make([]);
    await svc.publishInline(WS, 'u1', input({ campaignId: C2, labels: ['A'] }));
    expect(writes.inserted.metadata).toMatchObject({ campaignId: C2 });
    expect(writes.conflictSet.metadata).toMatchObject({ campaignId: C2 });
    expect(writes.inserted.metadata).not.toHaveProperty('labels');
    expect(writes.conflictSet.metadata).not.toHaveProperty('labels');
    expect(labels.setForPost).toHaveBeenCalledTimes(1);
    expect(labels.setForPost).toHaveBeenCalledWith(WS, 'd1', ['A']);
  });

  it('keeps the stored campaign and labels when the publish does not send them', async () => {
    const { svc, writes, labels } = make(
      stored({ campaignId: C1, labels: ['B'] }),
    );
    await svc.publishInline(WS, 'u1', input());
    expect(writes.conflictSet.metadata).toMatchObject({ campaignId: C1 });
    expect(labels.setForPost).not.toHaveBeenCalled();
  });

  it('refuses a campaign from another workspace before publishing', async () => {
    const { svc, writes } = make([], false);
    await expect(
      svc.publishInline(WS, 'u1', input({ campaignId: C2 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.inserted).toBeUndefined();
  });
});
