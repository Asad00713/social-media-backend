/**
 * Invite link and join by code against a real Postgres (rollback harness).
 * NOT RUN in the members lane worktree (no .env there): the controller runs
 * it after merge-back with
 *   PLANNER_DB_TESTS=1 npx jest src/workspace-members/invite-link.db.spec.ts --runInBand
 */
import type { PoolClient } from 'pg';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { AppLinks } from '../email/links/app-links';
import { WorkspaceMembersService } from './workspace-members.service';
import { InviteLinkService, INVITE_CODE_REGEX } from './invite-link.service';

// 0080: REMOVED status. 0090/0091: columns the full-row reads select, the
// invite link columns and their unique index. 0093: invited_by is NULLable.
const MIGRATIONS = [
  '0080_member_soft_removal.sql',
  '0090_user_account_settings.sql',
  '0091_workspace_settings.sql',
  '0093_users_fk_set_null.sql',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(client: PoolClient, name: string | null) {
  const email = `join-${rand()}@example.test`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  return { id: r.rows[0].id, email };
}

async function seedWorkspace(
  client: PoolClient,
  ownerId: string,
  opts: { name?: string; logo?: string | null; isActive?: boolean } = {},
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id, logo, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      opts.name ?? 'Rehman Works',
      `join-${rand()}`,
      ownerId,
      opts.logo ?? null,
      opts.isActive ?? true,
    ],
  );
  return r.rows[0].id;
}

async function seedMemberRow(
  client: PoolClient,
  workspaceId: string,
  person: { id: string; email: string },
  status: 'ACCEPTED' | 'REMOVED' | 'PENDING',
  userId: string | null = person.id,
) {
  await client.query(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, token, expires_at)
     VALUES ($1, $2, $3, 'MEMBER', $4, $5, $6::timestamp)`,
    [
      workspaceId,
      person.email,
      userId,
      status,
      rand() + rand(),
      new Date(Date.now() + 5 * DAY_MS).toISOString(),
    ],
  );
}

interface MemberRow {
  user_id: string | null;
  email: string;
  role: string;
  status: string;
  invited_by: string | null;
  token: string;
}

async function rowsOf(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<MemberRow[]> {
  const r = await client.query<MemberRow>(
    `SELECT user_id, email, role, status, invited_by, token
       FROM workspace_invitations
      WHERE workspace_id = $1 AND user_id = $2
      ORDER BY created_at, id`,
    [workspaceId, userId],
  );
  return r.rows;
}

/** The machine `code` of the 409 the call rejects with. */
async function conflictCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      statusCode: number;
      code: string;
    };
    expect(body.statusCode).toBe(409);
    return body.code;
  }
  throw new Error('expected a 409, the call resolved');
}

const codeOf = (state: { url: string | null }): string =>
  state.url!.split('/join/')[1];

interface Harness {
  links: InviteLinkService;
  usage: {
    getWorkspaceUsage: jest.Mock;
    incrementMemberCount: jest.Mock;
  };
  notify: jest.Mock;
}

/** The usage mock is stateful, so a second joiner sees the first one's seat. */
function run<T>(
  limits: { membersLimit: number; membersCount: number },
  fn: (h: Harness, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db: DbType, client) => {
    let membersCount = limits.membersCount;
    const usage = {
      getWorkspaceUsage: jest.fn(() =>
        Promise.resolve({ membersLimit: limits.membersLimit, membersCount }),
      ),
      incrementMemberCount: jest.fn(() => {
        membersCount += 1;
        return Promise.resolve();
      }),
    };
    const notify = jest.fn().mockResolvedValue(undefined);
    const recipients = {
      displayName: (u: { name: string | null }) => u.name ?? 'Someone',
    };
    const appLinks = {
      frontend: (path: string) => `https://app.test${path}`,
      members: (ws: string) => `https://app.test/w/${ws}/settings/team`,
    };
    const members = new WorkspaceMembersService(
      db,
      usage as never,
      { sendNow: jest.fn() } as never,
      {} as never,
      {} as never,
      { notify } as never,
      { invitationAccepted: jest.fn() } as never,
      recipients as never,
      appLinks as unknown as AppLinks,
    );
    const links = new InviteLinkService(
      db,
      usage as never,
      members,
      appLinks as unknown as AppLinks,
    );
    return fn({ links, usage, notify }, client);
  });
}

const ROOMY = { membersLimit: 10, membersCount: 1 };
const FULL = { membersLimit: 1, membersCount: 1 };
const ONE_LEFT = { membersLimit: 2, membersCount: 1 };

describeDb('InviteLinkService (database)', () => {
  describe('enable, disable, reset', () => {
    it('a fresh workspace has no link; enabling creates a code and a url ending in /join/<code>', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);

        expect(await links.get(ws)).toEqual({ enabled: false, url: null });

        const on = await links.setEnabled(ws, true);
        expect(on.enabled).toBe(true);
        const code = codeOf(on);
        expect(on.url).toBe(`https://app.test/join/${code}`);
        expect(code).toMatch(INVITE_CODE_REGEX);
        expect(code.startsWith('rw-')).toBe(true);
        expect(await links.get(ws)).toEqual(on);
      });
    });

    it('disabling keeps the code but hides the url; enabling again restores the same url', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const on = await links.setEnabled(ws, true);

        expect(await links.setEnabled(ws, false)).toEqual({
          enabled: false,
          url: null,
        });
        const stored = await client.query<{ invite_link_code: string }>(
          `SELECT invite_link_code FROM workspace WHERE id = $1`,
          [ws],
        );
        expect(stored.rows[0].invite_link_code).toBe(codeOf(on));

        expect(await links.setEnabled(ws, true)).toEqual(on);
        // Enabling twice never rotates the code.
        expect(await links.setEnabled(ws, true)).toEqual(on);
      });
    });

    it('reset issues a new code, keeps enabled, and the old code now 404s', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const oldCode = codeOf(await links.setEnabled(ws, true));

        const after = await links.reset(ws);
        const newCode = codeOf(after);
        expect(after.enabled).toBe(true);
        expect(newCode).not.toBe(oldCode);
        expect(newCode).toMatch(INVITE_CODE_REGEX);

        await expect(links.preview(oldCode)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(links.preview(newCode)).resolves.toBeDefined();
      });
    });

    it('reset on a disabled link stays disabled and shows a different url once enabled', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const on = await links.setEnabled(ws, true);
        await links.setEnabled(ws, false);

        expect(await links.reset(ws)).toEqual({ enabled: false, url: null });
        expect((await links.setEnabled(ws, true)).url).not.toBe(on.url);
      });
    });

    it('an unknown workspace is a 404 for every admin call', async () => {
      await run(ROOMY, async ({ links }) => {
        const ghost = '00000000-0000-4000-8000-000000000000';
        await expect(links.get(ghost)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(links.setEnabled(ghost, true)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(links.reset(ghost)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    it('two workspaces get different codes', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const a = await seedWorkspace(client, owner.id);
        const b = await seedWorkspace(client, owner.id);
        expect((await links.setEnabled(a, true)).url).not.toBe(
          (await links.setEnabled(b, true)).url,
        );
      });
    });
  });

  describe('preview', () => {
    it('returns the workspace name, logo and the owner name', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Rehman Owner');
        const ws = await seedWorkspace(client, owner.id, {
          logo: 'https://cdn.test/logo.png',
        });
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await links.preview(code)).toEqual({
          workspaceName: 'Rehman Works',
          workspaceLogo: 'https://cdn.test/logo.png',
          ownerName: 'Rehman Owner',
        });
      });
    });

    it('an owner without a name reads as a neutral label, never an email', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, null);
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        const preview = await links.preview(code);
        expect(preview.workspaceLogo).toBeNull();
        expect(preview.ownerName).toBe('The workspace owner');
        expect(JSON.stringify(preview)).not.toContain('@');
      });
    });

    it('a disabled, unknown or suspended link all give the same 404', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const disabledCode = codeOf(await links.setEnabled(ws, true));
        await links.setEnabled(ws, false);
        const suspended = await seedWorkspace(client, owner.id, {
          isActive: false,
        });
        const suspendedCode = codeOf(await links.setEnabled(suspended, true));

        const messages: string[] = [];
        for (const code of [disabledCode, 'zz-0000000000', suspendedCode]) {
          try {
            await links.preview(code);
            throw new Error('expected a 404');
          } catch (error) {
            expect(error).toBeInstanceOf(NotFoundException);
            messages.push((error as NotFoundException).message);
          }
        }
        expect(new Set(messages).size).toBe(1);
      });
    });
  });

  describe('join', () => {
    it('a non-member becomes an ACCEPTED MEMBER invited by the owner, counted once, and the owner is told', async () => {
      await run(ROOMY, async ({ links, usage, notify }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await links.join(code, joiner.id)).toEqual({ workspaceId: ws });

        const rows = await rowsOf(client, ws, joiner.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          user_id: joiner.id,
          email: joiner.email,
          role: 'MEMBER',
          status: 'ACCEPTED',
          invited_by: owner.id,
        });
        expect(rows[0].token).toMatch(/^[0-9a-f]{64}$/);
        expect(usage.incrementMemberCount).toHaveBeenCalledTimes(1);
        expect(usage.incrementMemberCount).toHaveBeenCalledWith(
          ws,
          joiner.id,
          joiner.id,
        );
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({
          userId: owner.id,
          workspaceId: ws,
          event: 'member_activity',
        });
      });
    });

    it('joining twice: the second is 409 ALREADY_MEMBER and adds nothing', async () => {
      await run(ROOMY, async ({ links, usage }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));
        await links.join(code, joiner.id);

        expect(await conflictCode(links.join(code, joiner.id))).toBe(
          'ALREADY_MEMBER',
        );
        expect(await rowsOf(client, ws, joiner.id)).toHaveLength(1);
        expect(usage.incrementMemberCount).toHaveBeenCalledTimes(1);
      });
    });

    it('a member added another way is 409 ALREADY_MEMBER', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const member = await seedUser(client, 'Member');
        const ws = await seedWorkspace(client, owner.id);
        await seedMemberRow(client, ws, member, 'ACCEPTED');
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await conflictCode(links.join(code, member.id))).toBe(
          'ALREADY_MEMBER',
        );
      });
    });

    it('an ACCEPTED row stored with a padded, upper-case address still counts as the member', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const member = await seedUser(client, 'Member');
        const ws = await seedWorkspace(client, owner.id);
        await seedMemberRow(
          client,
          ws,
          { id: member.id, email: ` ${member.email.toUpperCase()} ` },
          'ACCEPTED',
          null,
        );
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await conflictCode(links.join(code, member.id))).toBe(
          'ALREADY_MEMBER',
        );
      });
    });

    it('the owner is 409 ALREADY_MEMBER and gets no member row', async () => {
      await run(ROOMY, async ({ links, usage }, client) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await conflictCode(links.join(code, owner.id))).toBe(
          'ALREADY_MEMBER',
        );
        expect(await rowsOf(client, ws, owner.id)).toHaveLength(0);
        expect(usage.incrementMemberCount).not.toHaveBeenCalled();
      });
    });

    it('zero free seats is 409 SEAT_LIMIT_EXCEEDED and nothing is written', async () => {
      await run(FULL, async ({ links, usage, notify }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await conflictCode(links.join(code, joiner.id))).toBe(
          'SEAT_LIMIT_EXCEEDED',
        );
        expect(await rowsOf(client, ws, joiner.id)).toHaveLength(0);
        expect(usage.incrementMemberCount).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      });
    });

    it('a pending invitation holds a seat: the link cannot take a reserved one', async () => {
      await run(ONE_LEFT, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const invitee = await seedUser(client, 'Invitee');
        const ws = await seedWorkspace(client, owner.id);
        await seedMemberRow(client, ws, invitee, 'PENDING', null);
        const code = codeOf(await links.setEnabled(ws, true));

        expect(await conflictCode(links.join(code, joiner.id))).toBe(
          'SEAT_LIMIT_EXCEEDED',
        );
      });
    });

    it('the last seat goes to the first of two joiners; the second gets SEAT_LIMIT_EXCEEDED', async () => {
      await run(ONE_LEFT, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const first = await seedUser(client, 'First');
        const second = await seedUser(client, 'Second');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        await links.join(code, first.id);
        expect(await conflictCode(links.join(code, second.id))).toBe(
          'SEAT_LIMIT_EXCEEDED',
        );
        expect(await rowsOf(client, ws, second.id)).toHaveLength(0);
      });
    });

    it('a REMOVED row of the same user does not block: a new ACCEPTED row is inserted', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const returning = await seedUser(client, 'Returning');
        const ws = await seedWorkspace(client, owner.id);
        await seedMemberRow(client, ws, returning, 'REMOVED');
        const code = codeOf(await links.setEnabled(ws, true));

        await links.join(code, returning.id);

        const rows = await rowsOf(client, ws, returning.id);
        expect(rows.map((r) => r.status).sort()).toEqual([
          'ACCEPTED',
          'REMOVED',
        ]);
      });
    });

    it("the joiner's own pending invitation is dropped and does not cost a second seat", async () => {
      await run(ONE_LEFT, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const invited = await seedUser(client, 'Invited');
        const ws = await seedWorkspace(client, owner.id);
        // Other case and padding: the match is on the normalized address.
        await seedMemberRow(
          client,
          ws,
          { id: invited.id, email: ` ${invited.email.toUpperCase()} ` },
          'PENDING',
          null,
        );
        const code = codeOf(await links.setEnabled(ws, true));

        await links.join(code, invited.id);

        const all = await client.query<{ status: string }>(
          `SELECT status FROM workspace_invitations WHERE workspace_id = $1`,
          [ws],
        );
        expect(all.rows.map((r) => r.status)).toEqual(['ACCEPTED']);
      });
    });

    it('a disabled link refuses to join; so does a reset one with its old code', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));

        await links.setEnabled(ws, false);
        await expect(links.join(code, joiner.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );

        await links.setEnabled(ws, true);
        await links.reset(ws);
        await expect(links.join(code, joiner.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(await rowsOf(client, ws, joiner.id)).toHaveLength(0);
      });
    });

    it('a suspended workspace refuses to join', async () => {
      await run(ROOMY, async ({ links }, client) => {
        const owner = await seedUser(client, 'Owner');
        const joiner = await seedUser(client, 'Joiner');
        const ws = await seedWorkspace(client, owner.id);
        const code = codeOf(await links.setEnabled(ws, true));
        await client.query(
          `UPDATE workspace SET is_active = false WHERE id = $1`,
          [ws],
        );

        await expect(links.join(code, joiner.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });
  });
});
