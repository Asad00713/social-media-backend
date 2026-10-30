import {
  describeInboxDb,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import type { ConfigService } from '@nestjs/config';
import type { EmailService } from '../../../email/email.service';
import type { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import { InboxNotifyService } from './inbox-notify.service';
import type { InboxSettingsService } from './inbox-settings.service';

/** Exposes the two protected DB reads so they can be tested directly. */
class ExposedNotify extends InboxNotifyService {
  load(workspaceId: string, userIds?: string[]) {
    return this.loadMembers(workspaceId, userIds);
  }
  name(userId: string) {
    return this.displayName(userId);
  }
}

/** Boundary cast for a dependency the queries never touch. */
function unused<T>(): T {
  return {} as unknown as T;
}

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
      const svc = new ExposedNotify(
        unused<NotificationEmitterService>(),
        unused<EmailService>(),
        unused<InboxSettingsService>(),
        db,
        { set: () => Promise.resolve(null), del: () => Promise.resolve(0) },
        unused<ConfigService>(),
      );

      const all = await svc.load(workspaceId);
      expect(all.map((m) => m.id).sort()).toEqual(
        [ownerId, admin, guest].sort(),
      );
      for (const id of notMembers)
        expect(all.map((m) => m.id)).not.toContain(id);
      const some = await svc.load(workspaceId, [admin, 'not-a-member']);
      expect(some.map((m) => m.id)).toEqual([admin]);
      expect(await svc.load(workspaceId, [])).toEqual([]);
      expect(await svc.name(ownerId)).toBe('Owner');
    });
  });
});
