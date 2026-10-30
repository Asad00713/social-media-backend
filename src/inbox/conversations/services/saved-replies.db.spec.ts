import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  describeInboxDb,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { SavedRepliesService } from './saved-replies.service';

const mk = (shortcut: string, name = `Name ${shortcut}`) => ({
  name,
  shortcut,
  body: `Body for ${shortcut}`,
});

const TAKEN = {
  code: 'SHORTCUT_TAKEN',
  message: 'That shortcut is already used',
};

const TAKEN_MATCH: unknown = expect.objectContaining(TAKEN);

describeInboxDb('SavedRepliesService', () => {
  it('creates and lists live rows ordered by name, with the creator', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      await svc.create(workspaceId, ownerId, mk('zeta', 'Zeta'));
      const a = await svc.create(workspaceId, ownerId, mk('alpha', 'Alpha'));
      expect(a).toMatchObject({
        name: 'Alpha',
        shortcut: 'alpha',
        body: 'Body for alpha',
        usageCount: 0,
        createdBy: { id: ownerId, name: 'Owner', avatarUrl: null },
      });
      expect(typeof a.updatedAt).toBe('string');
      const list = await svc.list(workspaceId);
      expect(list.map((r) => r.name)).toEqual(['Alpha', 'Zeta']);
    }));

  it('answers 409 SHORTCUT_TAKEN on a duplicate shortcut, and the session survives', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      await svc.create(workspaceId, ownerId, mk('thanks'));
      const err = await svc
        .create(workspaceId, ownerId, mk('thanks', 'Other'))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual(TAKEN_MATCH);
      expect((await svc.list(workspaceId)).length).toBe(1);
    }));

  it('PATCH to a taken shortcut is 409; a partial patch keeps other fields', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      await svc.create(workspaceId, ownerId, mk('one'));
      const two = await svc.create(workspaceId, ownerId, mk('two'));
      await expect(
        svc.update(workspaceId, two.id, { shortcut: 'one' }),
      ).rejects.toMatchObject({ response: TAKEN_MATCH });
      const res = await svc.update(workspaceId, two.id, { name: 'Renamed' });
      expect(res).toMatchObject({
        name: 'Renamed',
        shortcut: 'two',
        body: 'Body for two',
      });
    }));

  it('delete then create the same shortcut works; restoring the first is 409', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      const first = await svc.create(workspaceId, ownerId, mk('hello'));
      await svc.remove(workspaceId, first.id);
      expect(await svc.list(workspaceId)).toEqual([]);
      await svc.create(workspaceId, ownerId, mk('hello', 'Second'));
      await expect(svc.restore(workspaceId, first.id)).rejects.toMatchObject({
        response: TAKEN_MATCH,
      });
      // the soft-deleted row is still there, not hard-deleted
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inbox_saved_replies WHERE id = $1 AND deleted_at IS NOT NULL`,
        [first.id],
      );
      expect(n.rows[0].n).toBe(1);
    }));

  it('restore clears deleted_at when the shortcut is free', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      const r = await svc.create(workspaceId, ownerId, mk('back'));
      await svc.remove(workspaceId, r.id);
      const restored = await svc.restore(workspaceId, r.id);
      expect(restored.id).toBe(r.id);
      expect((await svc.list(workspaceId)).map((x) => x.id)).toEqual([r.id]);
    }));

  it('use twice gives usageCount 2', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      const r = await svc.create(workspaceId, ownerId, mk('hi'));
      expect(await svc.use(workspaceId, r.id)).toEqual({ usageCount: 1 });
      expect(await svc.use(workspaceId, r.id)).toEqual({ usageCount: 2 });
    }));

  it("another workspace's reply is 404 on update, remove, restore and use; the same shortcut is allowed there", () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      const mine = await svc.create(a.workspaceId, a.ownerId, mk('shared'));
      await svc.create(b.workspaceId, b.ownerId, mk('shared'));
      await expect(
        svc.update(b.workspaceId, mine.id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.remove(b.workspaceId, mine.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.restore(b.workspaceId, mine.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.use(b.workspaceId, mine.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const listed = await svc.list(a.workspaceId);
      expect(listed).toHaveLength(1);
      expect(listed[0].usageCount).toBe(0);
      expect(listed[0].name).toBe('Name shared');
    }));

  it('update, use and remove on a soft-deleted row are 404', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedRepliesService(db);
      const r = await svc.create(workspaceId, ownerId, mk('gone'));
      await svc.remove(workspaceId, r.id);
      await expect(
        svc.update(workspaceId, r.id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.use(workspaceId, r.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.remove(workspaceId, r.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }));

  describe('search q', () => {
    it("'/than' matches shortcut thanks; matches name case-insensitively", () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const svc = new SavedRepliesService(db);
        await svc.create(workspaceId, ownerId, mk('thanks', 'Gratitude'));
        await svc.create(workspaceId, ownerId, mk('refund', 'Refund POLICY'));
        expect(
          (await svc.list(workspaceId, '/than')).map((r) => r.shortcut),
        ).toEqual(['thanks']);
        expect(
          (await svc.list(workspaceId, 'THAN')).map((r) => r.shortcut),
        ).toEqual(['thanks']);
        expect(
          (await svc.list(workspaceId, 'policy')).map((r) => r.shortcut),
        ).toEqual(['refund']);
        // shortcut is a PREFIX match, not a substring match
        expect(await svc.list(workspaceId, '/anks')).toEqual([]);
      }));

    it('treats % and _ literally', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const svc = new SavedRepliesService(db);
        await svc.create(workspaceId, ownerId, mk('50-off', 'Discount'));
        await svc.create(workspaceId, ownerId, mk('a-b', 'Plain'));
        await svc.create(workspaceId, ownerId, mk('axb', 'Plain two'));
        await svc.create(workspaceId, ownerId, mk('x', 'Save 50% now'));
        // '50%' must not act as a wildcard against shortcut 50-off; it only
        // matches the name that literally contains "50%".
        expect(
          (await svc.list(workspaceId, '50%')).map((r) => r.shortcut),
        ).toEqual(['x']);
        expect(await svc.list(workspaceId, '_')).toEqual([]);
        expect(
          (await svc.list(workspaceId, '%')).map((r) => r.shortcut),
        ).toEqual(['x']);
        expect(await svc.list(workspaceId, 'a_b')).toEqual([]);
      }));

    it('an empty or slash-only q lists everything', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const svc = new SavedRepliesService(db);
        await svc.create(workspaceId, ownerId, mk('a'));
        await svc.create(workspaceId, ownerId, mk('b'));
        expect(await svc.list(workspaceId, '/')).toHaveLength(2);
        expect(await svc.list(workspaceId, '')).toHaveLength(2);
      }));
  });
});
