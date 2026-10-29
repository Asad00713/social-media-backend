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
      // Real, existing users whose invitations never became membership.
      const notMembers: string[] = [];
      for (const status of ['PENDING', 'REJECTED', 'EXPIRED']) {
        const email = `${status.toLowerCase()}-${Date.now()}@example.test`;
        const u = await client.query<{ id: string }>(
          `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
          [email, status],
        );
        notMembers.push(u.rows[0].id);
        await client.query(
          `INSERT INTO workspace_invitations
             (workspace_id, email, user_id, role, status, invited_by, token, expires_at)
           VALUES ($1, $2, $3, 'MEMBER', $4::invitation_status, $5, $6,
                   now() + interval '7 days')`,
          [
            workspaceId,
            email,
            u.rows[0].id,
            status,
            ownerId,
            `tok-${status}-${Date.now()}`,
          ],
        );
      }
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
      for (const id of notMembers)
        expect(all.map((m: any) => m.id)).not.toContain(id);
      const some = await svc.loadMembers(workspaceId, [admin, 'not-a-member']);
      expect(some.map((m: any) => m.id)).toEqual([admin]);
      expect(await svc.loadMembers(workspaceId, [])).toEqual([]);
      expect(await svc.displayName(ownerId)).toBe('Owner');
    });
  });
});
