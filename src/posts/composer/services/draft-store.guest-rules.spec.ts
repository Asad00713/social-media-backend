/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ForbiddenException } from '@nestjs/common';
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
        calls.updated++;
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

describe('DraftStoreService.upsert Guest rules', () => {
  it('refuses a draft someone else created, and writes nothing', async () => {
    const { db, calls } = fakeDb([row({ createdById: 'other' })]);
    await expect(
      new DraftStoreService(db).upsert(WS, 'u1', dto, 'GUEST'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.updated).toBe(0);
  });

  it.each(['scheduled', 'published', 'failed'])(
    'refuses a row whose status is %s',
    async (status) => {
      const { db, calls } = fakeDb([row({ status })]);
      await expect(
        new DraftStoreService(db).upsert(WS, 'u1', dto, 'GUEST'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(calls.updated).toBe(0);
    },
  );

  it('allows editing their own draft', async () => {
    const { db, calls } = fakeDb([row()]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'GUEST');
    expect(calls.updated).toBe(1);
  });

  it('allows creating a new draft', async () => {
    const { db, calls } = fakeDb([]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'GUEST');
    expect(calls.inserted).toBe(1);
  });

  it('a MEMBER still overwrites a colleague row, as today', async () => {
    const { db, calls } = fakeDb([
      row({ createdById: 'other', status: 'scheduled' }),
    ]);
    await new DraftStoreService(db).upsert(WS, 'u1', dto, 'MEMBER');
    expect(calls.updated).toBe(1);
  });
});

describe('DraftStoreService.delete Guest rules', () => {
  it("refuses someone else's draft", async () => {
    const { db, calls } = fakeDb([row({ createdById: 'other' })]);
    await expect(
      new DraftStoreService(db).delete(WS, 'd1', 'u1', 'GUEST'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.deleted).toBe(0);
  });

  it('refuses a non-draft', async () => {
    const { db, calls } = fakeDb([row({ status: 'scheduled' })]);
    await expect(
      new DraftStoreService(db).delete(WS, 'd1', 'u1', 'GUEST'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.deleted).toBe(0);
  });

  it('allows deleting their own draft', async () => {
    const { db, calls } = fakeDb([row()]);
    await new DraftStoreService(db).delete(WS, 'd1', 'u1', 'GUEST');
    expect(calls.deleted).toBe(1);
  });

  it('a MEMBER can delete any row, as today', async () => {
    const { db, calls } = fakeDb([
      row({ createdById: 'other', status: 'scheduled' }),
    ]);
    await new DraftStoreService(db).delete(WS, 'd1', 'u1', 'MEMBER');
    expect(calls.deleted).toBe(1);
  });
});
