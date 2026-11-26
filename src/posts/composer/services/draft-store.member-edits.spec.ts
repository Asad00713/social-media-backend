/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { DraftStoreService } from './draft-store.service';

const WS = 'w1';

function fakeDb(existing: any[]) {
  const calls = { inserted: 0, updated: 0, deleted: 0 };
  const stamp = { createdAt: new Date(), updatedAt: new Date() };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => existing }) }),
    }),
    insert: () => ({
      values: (v: any) => {
        calls.inserted++;
        return { returning: async () => [{ ...v, ...stamp }] };
      },
    }),
    update: () => ({
      set: (v: any) => {
        // Discarding a draft is a soft delete (migration 0088): an UPDATE
        // setting deleted_at, not a DELETE. These tests are about who is
        // ALLOWED to discard, so they count the discard however it is spelled.
        if (v && v.deletedAt) calls.deleted++;
        else calls.updated++;
        return {
          where: () => ({
            returning: async () => [
              { id: 'd1', workspaceId: WS, ...v, ...stamp },
            ],
          }),
        };
      },
    }),
    delete: () => ({
      where: async () => {
        calls.deleted++;
      },
    }),
  };
  return { db, calls };
}

const dto = {
  draftId: 'd1',
  base: { text: 't', mediaItems: [], hashtags: [], mentions: [] },
  channels: [],
} as any;

const row = (over: any = {}) => ({
  id: 'd1',
  status: 'draft',
  createdById: 'u1',
  metadata: {},
  ...over,
});

describe("DraftStoreService: members and other people's drafts", () => {
  it('a MEMBER saves over a draft a former Viewer wrote', async () => {
    const { db, calls } = fakeDb([row({ createdById: 'former-viewer' })]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'MEMBER');
    expect(calls.updated).toBe(1);
  });

  it('a MEMBER still overwrites a colleague row', async () => {
    const { db, calls } = fakeDb([
      row({ createdById: 'other', status: 'scheduled' }),
    ]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'MEMBER');
    expect(calls.updated).toBe(1);
  });

  it('a MEMBER creates a new draft', async () => {
    const { db, calls } = fakeDb([]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'MEMBER');
    expect(calls.inserted).toBe(1);
  });

  it('a MEMBER deletes a draft a former Viewer wrote', async () => {
    const { db, calls } = fakeDb([row({ createdById: 'former-viewer' })]);
    await new DraftStoreService(db).delete(WS, 'd1', 'u1', 'MEMBER');
    expect(calls.deleted).toBe(1);
  });

  it('a MEMBER can delete any row', async () => {
    const { db, calls } = fakeDb([
      row({ createdById: 'other', status: 'scheduled' }),
    ]);
    await new DraftStoreService(db).delete(WS, 'd1', 'u1', 'MEMBER');
    expect(calls.deleted).toBe(1);
  });
});
