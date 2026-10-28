import {
  describeInboxDb,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { InboxNotifyService } from './inbox-notify.service';

describeInboxDb('InboxNotifyService recipient queries', () => {
  it('loads the owner and accepted members only, and names users', async () => {
    await withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const admin = await seedMember(client, workspaceId, 'ADMIN');
      const guest = await seedMember(client, workspaceId, 'GUEST');
      const pendingEmail = `pending-${Date.now()}@example.test`;
      await client.query(
        `INSERT INTO workspace_invitations
           (workspace_id, email, role, status, invited_by, token, expires_at)
         VALUES ($1, $2, 'MEMBER', 'PENDING', $3, $4, now() + interval '7 days')`,
        [workspaceId, pendingEmail, ownerId, `tok-${Date.now()}`],
      );
      const svc = new InboxNotifyService(
        {} as any,
        {} as any,
        {} as any,
        db as any,
        {} as any,
        {} as any,
      ) as any;

      const all = await svc.loadMembers(workspaceId);
      expect(all.map((m: any) => m.id).sort()).toEqual(
        [ownerId, admin, guest].sort(),
      );
      const some = await svc.loadMembers(workspaceId, [admin, 'not-a-member']);
      expect(some.map((m: any) => m.id)).toEqual([admin]);
      expect(await svc.loadMembers(workspaceId, [])).toEqual([]);
      expect(await svc.displayName(ownerId)).toBe('Owner');
    });
  });
});
