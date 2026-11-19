import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { SubscriptionService } from '../billing/services/subscription.service';
import type { UsageService } from '../billing/services/usage.service';
import {
  avatarKeyFolder,
  type CloudflareR2Service,
} from '../media/cloudflare-r2.service';
import { AccountDeletionService } from './account-deletion.service';

// 0058: post_comments, seeded to prove they stay. 0060/0067/0068/0072:
// insight_hidden_steps, channel_connect_links, notification_preferences and
// known_devices, which the delete clears. 0070/0071/0073: the users columns
// the anonymising update writes and the schema selects. 0080: REMOVED memberships. 0090: users.deleted_at and preferences.
// 0091/0092: workspace columns the schema selects. 0093: invited_by and
// changed_by_user_id SET NULL, workspace.owner_id RESTRICT.
const MIGRATIONS = [
  '0058_post_comments.sql',
  '0060_insight_hidden_steps.sql',
  '0067_channel_connect_links.sql',
  '0068_notification_preferences.sql',
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0072_known_devices.sql',
  '0073_users_email_changed_at.sql',
  '0080_member_soft_removal.sql',
  '0090_user_account_settings.sql',
  '0091_workspace_settings.sql',
  '0092_workspace_labels.sql',
  '0093_users_fk_set_null.sql',
];

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(
  client: PoolClient,
  email = `ad-${rand()}@example.test`,
): Promise<{ id: string; email: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, password, google_sub, avatar_url,
                        preferences, last_login_ip, country, country_code,
                        suspension_note)
     VALUES ($1, 'Old Name', 'hash', $2, 'https://x.test/a.png',
             '{"theme":"dark"}', '1.2.3.4', 'Pakistan', 'PK',
             'Old Name was warned twice')
     RETURNING id`,
    [email, `g-${rand()}`],
  );
  return { id: r.rows[0].id, email };
}

async function seedWorkspace(
  client: PoolClient,
  ownerId: string,
  name: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, `ad-${rand()}`, ownerId],
  );
  return r.rows[0].id;
}

async function seedInvitation(
  client: PoolClient,
  workspaceId: string,
  email: string,
  userId: string | null,
  status: 'ACCEPTED' | 'PENDING' | 'REMOVED',
  invitedBy: string | null,
  role: 'ADMIN' | 'MEMBER' | 'GUEST' = 'MEMBER',
): Promise<string> {
  // A REMOVED row is seeded as a removal by `invitedBy` a day ago, as the
  // members service writes one (removed_at + removed_by).
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, invited_by, token, expires_at,
        removed_at, removed_by)
     VALUES ($1, $2, $3, $6, $4, $5, $7, now() + interval '7 days',
             CASE WHEN $4::invitation_status = 'REMOVED' THEN now() - interval '1 day' END,
             CASE WHEN $4::invitation_status = 'REMOVED' THEN $5::uuid END)
     RETURNING id`,
    [workspaceId, email, userId, status, invitedBy, role, rand() + rand()],
  );
  return r.rows[0].id;
}

function makeService(
  db: DbType,
  cancel: () => Promise<unknown> = () => Promise.resolve('none'),
) {
  const subscriptions = { cancelForAccount: jest.fn(cancel) };
  const usage = {
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  // Never the real R2 client.
  const r2 = {
    isOwnPublicUrl: jest.fn<boolean, [string, string]>(() => false),
    keyFromPublicUrl: jest.fn<string | null, [string]>(() => null),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AccountDeletionService(
    db,
    subscriptions as unknown as SubscriptionService,
    usage as unknown as UsageService,
    r2 as unknown as CloudflareR2Service,
  );
  return { service, subscriptions, usage, r2 };
}

async function userRow(client: PoolClient, id: string) {
  const r = await client.query<Record<string, unknown>>(
    `SELECT * FROM users WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function count(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<number> {
  const r = await client.query<{ n: string }>(sql, params);
  return Number(r.rows[0].n);
}

describeDb('AccountDeletionService (database)', () => {
  it('an owner gets 409 OWNS_WORKSPACES listing {id, name}, and nothing changes', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client);
      const w = await seedWorkspace(client, me.id, 'Mine');
      const before = await userRow(client, me.id);
      const { service, subscriptions } = makeService(db);

      await expect(
        service.deleteAccount(me.id, {
          confirmEmail: me.email,
          actor: 'self',
          actorId: me.id,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'OWNS_WORKSPACES',
          workspaces: [{ id: w, name: 'Mine' }],
        },
      });
      expect(subscriptions.cancelForAccount).not.toHaveBeenCalled();
      expect(await userRow(client, me.id)).toEqual(before);
    });
  });

  it('a member of two workspaces is anonymised; their posts, comments and sent invitations stay', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const oldEmail = `old-${rand()}@example.com`;
      const me = await seedUser(client, oldEmail);
      const hina = await seedUser(client);
      const w1 = await seedWorkspace(client, hina.id, 'Hina One');
      const w2 = await seedWorkspace(client, hina.id, 'Hina Two');
      const w3 = await seedWorkspace(client, hina.id, 'Hina Three');
      const m1 = await seedInvitation(
        client,
        w1,
        me.email,
        me.id,
        'ACCEPTED',
        hina.id,
      );
      const m2 = await seedInvitation(
        client,
        w2,
        me.email,
        me.id,
        'ACCEPTED',
        hina.id,
      );
      // Sent to my address before I had an account: no user_id, other case.
      const pendingByEmail = await seedInvitation(
        client,
        w3,
        oldEmail.toUpperCase(),
        null,
        'PENDING',
        hina.id,
      );
      // An admin removed me from w3 earlier: the row keeps its status, but
      // not my address.
      const earlierRemoved = await seedInvitation(
        client,
        w3,
        me.email,
        me.id,
        'REMOVED',
        hina.id,
      );
      // My Stripe customer row: kept for billing history, email nulled.
      await client.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, email)
         VALUES ($1, $2, $3)`,
        [me.id, `cus_${rand()}`, oldEmail],
      );
      // An invitation I sent stays, still naming me.
      const sent = await seedInvitation(
        client,
        w1,
        `friend-${rand()}@example.test`,
        null,
        'PENDING',
        me.id,
      );

      await client.query(
        `INSERT INTO known_devices (user_id, device_hash, label)
         VALUES ($1, $2, 'Chrome on Windows')`,
        [me.id, 'a'.repeat(64)],
      );
      await client.query(
        `INSERT INTO notification_preferences (user_id, workspace_id, event, channel, enabled)
         VALUES ($1, $2, 'post_failed', 'email', false)`,
        [me.id, w1],
      );
      await client.query(
        `INSERT INTO conversations (user_id, workspace_id, title) VALUES ($1, $2, 'chat')`,
        [me.id, w1],
      );
      const post = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, status, content, targets)
         VALUES ($1, $2, 'draft', 'mine', '[]'::jsonb) RETURNING id`,
        [w1, me.id],
      );
      const postId = post.rows[0].id;
      const comment = await client.query<{ id: string }>(
        `INSERT INTO post_comments (post_id, workspace_id, user_id, body)
         VALUES ($1, $2, $3, 'nice') RETURNING id`,
        [postId, w1, me.id],
      );
      // I changed a plan once (subscription_changes.changed_by_user_id).
      const plan = `AD${rand()}`.toUpperCase();
      await client.query(
        `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace,
                            members_per_workspace, max_workspaces)
         VALUES ($1, 'Test', 0, 1, 1, 1)`,
        [plan],
      );
      const sub = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (user_id, plan_code, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [hina.id, plan],
      );
      const change = await client.query<{ id: string }>(
        `INSERT INTO subscription_changes (subscription_id, change_type, changed_by_user_id)
         VALUES ($1, 'PLAN_UPGRADED', $2) RETURNING id`,
        [sub.rows[0].id, me.id],
      );

      const { service, usage, r2 } = makeService(db);
      await service.deleteAccount(me.id, {
        confirmEmail: ` ${oldEmail.replace('old', 'Old')} `,
        actor: 'self',
        actorId: me.id,
      });

      // Memberships, including the email-only PENDING one.
      const ms = await client.query<{
        status: string;
        removed_by: string | null;
        removed_at: Date | null;
      }>(
        `SELECT status, removed_by, removed_at FROM workspace_invitations
          WHERE id = ANY($1::uuid[])`,
        [[m1, m2, pendingByEmail]],
      );
      expect(ms.rows).toHaveLength(3);
      for (const row of ms.rows) {
        expect(row.status).toBe('REMOVED');
        expect(row.removed_by).toBe(me.id);
        expect(row.removed_at).not.toBeNull();
      }
      // Only the ACCEPTED ones held a seat.
      expect(
        (usage.decrementMemberCount.mock.calls as [string][])
          .map((c) => c[0])
          .sort(),
      ).toEqual([w1, w2].sort());

      // The old address survives on no invitation row tied to me, whatever
      // its status, nor on the email-matched one that had no user_id.
      const anon = `deleted+${me.id}@deleted.invalid`;
      const emails = await client.query<{ id: string; email: string }>(
        `SELECT id, email FROM workspace_invitations
          WHERE id = ANY($1::uuid[]) OR user_id = $2`,
        [[m1, m2, pendingByEmail, earlierRemoved], me.id],
      );
      expect(emails.rows).toHaveLength(4);
      for (const row of emails.rows) expect(row.email).toBe(anon);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM workspace_invitations
            WHERE lower(email) = lower($1)`,
          [oldEmail],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM workspace_invitations
            WHERE id = $1 AND status = 'REMOVED' AND removed_by = $2`,
          [earlierRemoved, hina.id],
        ),
      ).toBe(1);
      const customer = await client.query<{ email: string | null }>(
        `SELECT email FROM stripe_customers WHERE user_id = $1`,
        [me.id],
      );
      expect(customer.rows).toEqual([{ email: null }]);
      // The seeded avatar URL is not one of our R2 keys: nothing deleted.
      expect(r2.deleteObject).not.toHaveBeenCalled();

      const u = await userRow(client, me.id);
      expect(u.email).toBe(anon);
      for (const col of [
        'name',
        'password',
        'google_sub',
        'avatar_url',
        'pending_email',
        'pending_email_code_hash',
        'pending_email_expires_at',
        'email_verification_token',
        'password_reset_token',
        'last_login_ip',
        'country',
        'country_code',
        'suspension_note',
      ]) {
        expect([col, u[col]]).toEqual([col, null]);
      }
      expect(u.preferences).toEqual({});
      expect(u.is_active).toBe(false);
      expect(u.deleted_at).not.toBeNull();
      expect(u.sessions_revoked_at).not.toBeNull();

      for (const table of [
        'known_devices',
        'notification_preferences',
        'conversations',
      ]) {
        expect([
          table,
          await count(
            client,
            `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`,
            [me.id],
          ),
        ]).toEqual([table, 0]);
      }

      // Workspace data keeps the same author id.
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM posts WHERE id = $1 AND created_by_id = $2`,
          [postId, me.id],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM post_comments WHERE id = $1 AND user_id = $2`,
          [comment.rows[0].id, me.id],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM workspace_invitations
            WHERE id = $1 AND invited_by = $2 AND status = 'PENDING'`,
          [sent, me.id],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM subscription_changes
            WHERE id = $1 AND changed_by_user_id = $2`,
          [change.rows[0].id, me.id],
        ),
      ).toBe(1);

      const audit = await client.query<{
        action: string;
        actor_id: string;
        actor_email: string | null;
        target_label: string | null;
      }>(
        `SELECT action, actor_id, actor_email, target_label FROM admin_audit_logs
          WHERE target_type = 'user' AND target_id = $1`,
        [me.id],
      );
      expect(audit.rows).toEqual([
        {
          action: 'user.self_delete',
          actor_id: me.id,
          actor_email: null,
          target_label: null,
        },
      ]);

      // The old address is free again.
      await expect(
        client.query(`INSERT INTO users (email) VALUES ($1)`, [oldEmail]),
      ).resolves.toBeDefined();
    });
  });

  it('a different email is 400 EMAIL_MISMATCH and nothing changes', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client, `old-${rand()}@example.com`);
      const before = await userRow(client, me.id);
      const { service } = makeService(db);

      await expect(
        service.deleteAccount(me.id, {
          confirmEmail: 'other@x.com',
          actor: 'self',
          actorId: me.id,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'EMAIL_MISMATCH' },
      });
      expect(await userRow(client, me.id)).toEqual(before);
    });
  });

  it('a billing cancel failure is 502 BILLING_CANCEL_FAILED and the user row is untouched', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client);
      const hina = await seedUser(client);
      const w = await seedWorkspace(client, hina.id, 'Hina');
      const m = await seedInvitation(
        client,
        w,
        me.email,
        me.id,
        'ACCEPTED',
        hina.id,
      );
      const before = await userRow(client, me.id);
      const { service } = makeService(db, () =>
        Promise.reject(new Error('provider down')),
      );

      await expect(
        service.deleteAccount(me.id, {
          confirmEmail: me.email,
          actor: 'self',
          actorId: me.id,
        }),
      ).rejects.toMatchObject({
        status: 502,
        response: { code: 'BILLING_CANCEL_FAILED' },
      });
      expect(await userRow(client, me.id)).toEqual(before);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM workspace_invitations
            WHERE id = $1 AND status = 'ACCEPTED'`,
          [m],
        ),
      ).toBe(1);
    });
  });

  it('a super admin delete is audited as user.admin_delete with the admin as actor', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client);
      const admin = await seedUser(client);
      const { service } = makeService(db);

      await service.deleteAccount(me.id, {
        actor: 'super_admin',
        actorId: admin.id,
      });

      const audit = await client.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM admin_audit_logs WHERE target_id = $1`,
        [me.id],
      );
      expect(audit.rows).toEqual([
        { action: 'user.admin_delete', actor_id: admin.id },
      ]);
    });
  });

  it('a guest holds no seat: GUEST in A and MEMBER in B, only B is decremented, both REMOVED', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client);
      const hina = await seedUser(client);
      const wA = await seedWorkspace(client, hina.id, 'A');
      const wB = await seedWorkspace(client, hina.id, 'B');
      const asGuest = await seedInvitation(
        client,
        wA,
        me.email,
        me.id,
        'ACCEPTED',
        hina.id,
        'GUEST',
      );
      const asMember = await seedInvitation(
        client,
        wB,
        me.email,
        me.id,
        'ACCEPTED',
        hina.id,
        'MEMBER',
      );
      const { service, usage } = makeService(db);

      await service.deleteAccount(me.id, {
        confirmEmail: me.email,
        actor: 'self',
        actorId: me.id,
      });

      expect(usage.decrementMemberCount.mock.calls).toEqual([
        [wB, me.id, me.id],
      ]);
      expect(
        await count(
          client,
          `SELECT count(*) AS n FROM workspace_invitations
            WHERE id = ANY($1::uuid[]) AND status = 'REMOVED'`,
          [[asGuest, asMember]],
        ),
      ).toBe(2);
    });
  });

  it('an own R2 avatar is deleted by its exact key, read under the lock', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const me = await seedUser(client);
      // An avatar in the person's own folder, as an upload would key it.
      const key = `${avatarKeyFolder(me.id)}1700000000000-0123456789abcdef01234567.png`;
      const url = `https://x.test/${key}`;
      await client.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [
        me.id,
        url,
      ]);
      const { service, r2 } = makeService(db);
      r2.isOwnPublicUrl.mockReturnValue(true);
      r2.keyFromPublicUrl.mockImplementation((url: string) =>
        url.slice('https://x.test/'.length),
      );

      await service.deleteAccount(me.id, {
        confirmEmail: me.email,
        actor: 'self',
        actorId: me.id,
      });

      // The avatar_url as the row held it before anonymising.
      expect(r2.isOwnPublicUrl).toHaveBeenCalledWith(url, 'avatar');
      expect(r2.deleteObject.mock.calls).toEqual([[key]]);
      expect((await userRow(client, me.id)).avatar_url).toBeNull();
    });
  });
});
