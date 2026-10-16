/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { DraftStoreService } from './draft-store.service';

const WS = 'w1';

function fakeDb(existing: any[]) {
  const captured: { inserted?: any; updated?: any } = {};
  const stamp = { createdAt: new Date(), updatedAt: new Date() };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => existing }) }),
    }),
    insert: () => ({
      values: (v: any) => {
        captured.inserted = v;
        return { returning: async () => [{ ...v, ...stamp }] };
      },
    }),
    update: () => ({
      set: (v: any) => {
        captured.updated = v;
        return {
          where: () => ({
            returning: async () => [
              { id: 'd1', workspaceId: WS, createdById: 'u1', ...v, ...stamp },
            ],
          }),
        };
      },
    }),
  };
  return { db, captured };
}

const dto = (over: any = {}) => ({
  draftId: 'd1',
  base: {
    text: 'edited caption',
    mediaItems: [],
    hashtags: ['x'],
    mentions: [],
  },
  channels: [],
  ...over,
});

describe('DraftStoreService.upsert keeps the first-week tag', () => {
  it('carries source, slot and suggestedAt through an edit-and-save', async () => {
    const { db, captured } = fakeDb([
      {
        id: 'd1',
        metadata: {
          source: 'first_week',
          firstWeekSlot: 2,
          suggestedAt: '2026-10-17T04:00:00.000Z',
          imageCredit: { provider: 'pexels' },
        },
      },
    ]);
    await new DraftStoreService(db as any).upsert(WS, 'u1', dto());
    expect(captured.updated.metadata).toMatchObject({
      source: 'first_week',
      firstWeekSlot: 2,
      suggestedAt: '2026-10-17T04:00:00.000Z',
      imageCredit: { provider: 'pexels' },
      hashtags: ['x'], // the composer's own keys are still written
    });
  });

  it('adds no first-week keys to an ordinary draft', async () => {
    const { db, captured } = fakeDb([
      { id: 'd1', metadata: { title: 'mine' } },
    ]);
    await new DraftStoreService(db as any).upsert(WS, 'u1', dto());
    expect(captured.updated.metadata.source).toBeUndefined();
    expect(captured.updated.metadata.firstWeekSlot).toBeUndefined();
  });

  it('adds no first-week keys to a brand-new draft', async () => {
    const { db, captured } = fakeDb([]);
    await new DraftStoreService(db as any).upsert(WS, 'u1', dto());
    expect(captured.inserted.metadata.source).toBeUndefined();
  });
});
