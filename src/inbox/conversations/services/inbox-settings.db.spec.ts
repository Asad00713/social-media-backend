import {
  describeInboxDb,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import {
  DEFAULT_INBOX_SETTINGS,
  InboxSettingsService,
} from './inbox-settings.service';

const count = async (client: {
  query: (q: string) => Promise<{ rows: { n: number }[] }>;
}) =>
  (await client.query('SELECT count(*)::int AS n FROM inbox_user_settings'))
    .rows[0].n;

describeInboxDb('InboxSettingsService', () => {
  it('returns defaults when there is no row, and inserts nothing', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new InboxSettingsService(db);
      expect(await svc.get(ownerId, workspaceId)).toEqual(
        DEFAULT_INBOX_SETTINGS,
      );
      expect(await count(client)).toBe(0);
    }));

  it('stores only the provided keys; other users keep defaults', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedMember(client, workspaceId, 'MEMBER');
      const svc = new InboxSettingsService(db);
      await svc.update(ownerId, workspaceId, { notify: 'nothing' });
      expect(await svc.get(ownerId, workspaceId)).toEqual({
        ...DEFAULT_INBOX_SETTINGS,
        notify: 'nothing',
      });
      expect(await svc.get(other, workspaceId)).toEqual(DEFAULT_INBOX_SETTINGS);
    }));

  it('keeps earlier partial updates across later ones', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new InboxSettingsService(db);
      await svc.update(ownerId, workspaceId, { notify: 'everything' });
      const res = await svc.update(ownerId, workspaceId, {
        defaultLater: 'next_week',
      });
      expect(res).toEqual({
        ...DEFAULT_INBOX_SETTINGS,
        notify: 'everything',
        defaultLater: 'next_week',
      });
      await svc.update(ownerId, workspaceId, { aiQuickReplies: false });
      expect(await svc.get(ownerId, workspaceId)).toEqual({
        ...DEFAULT_INBOX_SETTINGS,
        notify: 'everything',
        defaultLater: 'next_week',
        aiQuickReplies: false,
      });
    }));

  it('an empty patch writes nothing', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new InboxSettingsService(db);
      expect(await svc.update(ownerId, workspaceId, {})).toEqual(
        DEFAULT_INBOX_SETTINGS,
      );
      expect(await count(client)).toBe(0);
    }));

  it('getMany returns every requested user with defaults filled', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const b = await seedMember(client, workspaceId, 'MEMBER');
      const svc = new InboxSettingsService(db);
      await svc.update(b, workspaceId, { markDoneOnReply: false });
      const map = await svc.getMany([ownerId, b], workspaceId);
      expect(map.get(ownerId)).toEqual(DEFAULT_INBOX_SETTINGS);
      expect(map.get(b)).toEqual({
        ...DEFAULT_INBOX_SETTINGS,
        markDoneOnReply: false,
      });
      expect((await svc.getMany([], workspaceId)).size).toBe(0);
    }));
});
