import type { PoolClient } from 'pg';
import { seedMember, seedWorkspace } from '../../inbox/testing/inbox-db';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import type { NewInsightReportRow } from '../../drizzle/schema/insight-reports.schema';
import { ReportsRepository } from './reports.repository';

const MIGRATIONS = ['0064_insight_reports.sql'];

function run<T>(
  fn: (repo: ReportsRepository, client: PoolClient, db: DbType) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db, client) =>
    fn(new ReportsRepository(db), client, db),
  );
}

function values(
  workspaceId: string,
  over: Partial<NewInsightReportRow> = {},
): NewInsightReportRow {
  return {
    workspaceId,
    name: 'Monthly review',
    channelIds: [3, 1],
    period: 'last_month',
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['brief', 'totals'],
    ...over,
  };
}

async function seedMedia(
  client: PoolClient,
  workspaceId: string,
  uploaderId: string,
  over: { url?: string; isDeleted?: boolean | null; type?: string } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_items (workspace_id, uploaded_by_id, type, name, file_url, mime_type, is_deleted)
     VALUES ($1, $2, $3, 'logo.png', $4, 'image/png', $5) RETURNING id`,
    [
      workspaceId,
      uploaderId,
      over.type ?? 'image',
      over.url ?? 'https://cdn.test/logo.png',
      over.isDeleted === undefined ? false : over.isDeleted,
    ],
  );
  return r.rows[0].id;
}

/** A report whose audit columns are in the past, to prove a write left them. */
async function seedAged(
  repo: ReportsRepository,
  client: PoolClient,
  workspaceId: string,
  over: Partial<NewInsightReportRow> = {},
): Promise<string> {
  const id = await repo.insert(values(workspaceId, over));
  await client.query(
    `UPDATE insight_reports SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
    [id],
  );
  return id;
}

async function updatedAt(client: PoolClient, id: string): Promise<string> {
  const r = await client.query<{ at: Date }>(
    `SELECT updated_at AS at FROM insight_reports WHERE id = $1`,
    [id],
  );
  return r.rows[0].at.toISOString();
}

describeDb('ReportsRepository (database)', () => {
  it('inserts and reads a report back, scoped to its workspace', async () => {
    await run(async (repo, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const id = await repo.insert(
        values(a.workspaceId, { note: 'Hello', createdBy: a.ownerId }),
      );

      const got = await repo.get(a.workspaceId, id);
      expect(got?.row).toMatchObject({
        id,
        workspaceId: a.workspaceId,
        name: 'Monthly review',
        channelIds: [3, 1],
        sections: ['brief', 'totals'],
        note: 'Hello',
        optedOut: [],
        recipients: [],
        attachPdf: true,
        sendToTeam: false,
        shareToken: null,
      });
      expect(got?.logoUrl).toBeNull();
      expect(got?.createdBy).toEqual({ id: a.ownerId, name: 'Owner' });
      expect(got?.updatedBy).toBeNull();

      expect(await repo.get(b.workspaceId, id)).toBeNull();
      expect((await repo.getById(id))?.row.id).toBe(id);
      expect(
        await repo.getById('00000000-0000-0000-0000-000000000000'),
      ).toBeNull();
    });
  });

  it('lists only the workspace, newest created_at first', async () => {
    await run(async (repo, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const old = await repo.insert(values(a.workspaceId, { name: 'Old' }));
      const fresh = await repo.insert(values(a.workspaceId, { name: 'Fresh' }));
      await repo.insert(values(b.workspaceId, { name: 'Elsewhere' }));
      await client.query(
        `UPDATE insight_reports SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
        [old],
      );
      await client.query(
        `UPDATE insight_reports SET created_at = '2026-06-01T00:00:00Z' WHERE id = $1`,
        [fresh],
      );
      const list = await repo.list(a.workspaceId);
      expect(list.map((r) => r.row.name)).toEqual(['Fresh', 'Old']);
      expect(await repo.list('00000000-0000-0000-0000-000000000000')).toEqual(
        [],
      );
    });
  });

  it('names a person by name, or by the part of the email before the @', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const blank = await seedMember(client, workspaceId, 'ADMIN', {
        name: '',
        email: 'omar.k@acme.com',
      });
      const id = await repo.insert(
        values(workspaceId, { createdBy: ownerId, updatedBy: blank }),
      );
      const got = await repo.get(workspaceId, id);
      expect(got?.createdBy).toEqual({ id: ownerId, name: 'Owner' });
      expect(got?.updatedBy).toEqual({ id: blank, name: 'omar.k' });
    });
  });

  it('updates and removes only inside the workspace', async () => {
    await run(async (repo, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const id = await repo.insert(values(a.workspaceId));

      expect(await repo.update(b.workspaceId, id, { name: 'Hijack' })).toBe(
        false,
      );
      expect(await repo.update(a.workspaceId, id, { name: 'Renamed' })).toBe(
        true,
      );
      expect((await repo.get(a.workspaceId, id))?.row.name).toBe('Renamed');

      expect(await repo.remove(b.workspaceId, id)).toBe(false);
      expect(await repo.remove(a.workspaceId, id)).toBe(true);
      expect(await repo.remove(a.workspaceId, id)).toBe(false);
      expect(await repo.get(a.workspaceId, id)).toBeNull();
    });
  });

  it('reads the workspace name, active flag and a safe time zone', async () => {
    await run(async (repo, client) => {
      const { workspaceId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      expect(await repo.workspaceInfo(workspaceId)).toEqual({
        name: 'Inbox WS',
        timezone: 'Asia/Karachi',
        isActive: true,
      });

      await client.query(
        `UPDATE workspace SET timezone = 'Not/AZone', is_active = false WHERE id = $1`,
        [workspaceId],
      );
      expect(await repo.workspaceInfo(workspaceId)).toEqual({
        name: 'Inbox WS',
        timezone: 'UTC',
        isActive: false,
      });
      expect(
        await repo.workspaceInfo('00000000-0000-0000-0000-000000000000'),
      ).toBeNull();
    });
  });

  describe('team', () => {
    it('is the owner plus accepted members, the owner flagged', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const memberId = await seedMember(client, workspaceId, 'MEMBER', {
          email: 'member@acme.com',
        });
        const team = await repo.team(workspaceId);
        expect(team).toHaveLength(2);
        expect(team.find((p) => p.isOwner)?.userId).toBe(ownerId);
        expect(team.find((p) => !p.isOwner)).toEqual({
          userId: memberId,
          email: 'member@acme.com',
          isOwner: false,
        });
      });
    });

    it('leaves out a pending invitation and a rejected one', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const invitee = await client.query<{ id: string }>(
          `INSERT INTO users (email, name) VALUES ('pending@acme.com', 'P') RETURNING id`,
        );
        for (const [status, token] of [
          ['PENDING', 't1'],
          ['REJECTED', 't2'],
        ]) {
          await client.query(
            `INSERT INTO workspace_invitations
               (workspace_id, email, user_id, role, status, invited_by, token, expires_at)
             VALUES ($1, 'pending@acme.com', $2, 'MEMBER', $3::invitation_status, $4, $5, now() + interval '7 days')`,
            [workspaceId, invitee.rows[0].id, status, ownerId, token],
          );
        }
        const team = await repo.team(workspaceId);
        expect(team.map((p) => p.userId)).toEqual([ownerId]);
      });
    });

    it('leaves out a suspended member', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const memberId = await seedMember(client, workspaceId, 'MEMBER');
        await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [
          memberId,
        ]);
        expect((await repo.team(workspaceId)).map((p) => p.userId)).toEqual([
          ownerId,
        ]);
      });
    });

    it('lists a user once even with two accepted invitations', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const memberId = await seedMember(client, workspaceId, 'MEMBER', {
          email: 'dup@acme.com',
        });
        await client.query(
          `INSERT INTO workspace_invitations
             (workspace_id, email, user_id, role, status, invited_by, token, expires_at)
           VALUES ($1, 'dup@acme.com', $2, 'ADMIN', 'ACCEPTED', $3, 'dup-token', now() + interval '7 days')`,
          [workspaceId, memberId, ownerId],
        );
        const team = await repo.team(workspaceId);
        expect(team.filter((p) => p.userId === memberId)).toHaveLength(1);
        expect(team).toHaveLength(2);
      });
    });

    it('drops a suspended owner, so there may be no owner to reply to', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const memberId = await seedMember(client, workspaceId, 'ADMIN');
        await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [
          ownerId,
        ]);
        const team = await repo.team(workspaceId);
        expect(team.map((p) => p.userId)).toEqual([memberId]);
        expect(team.some((p) => p.isOwner)).toBe(false);
      });
    });
  });

  describe('optOut', () => {
    it('lowercases, keeps one entry on a repeat, and leaves updated_at alone', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const id = await seedAged(repo, client, workspaceId, {
          name: 'Weekly',
        });
        const before = await updatedAt(client, id);

        const first = await repo.optOut(id, 'Sara@Acme.com');
        const second = await repo.optOut(id, 'SARA@acme.com');
        expect(first).toEqual({
          reportName: 'Weekly',
          workspaceName: 'Inbox WS',
        });
        expect(second).toEqual(first);

        const got = await repo.get(workspaceId, id);
        expect(got?.row.optedOut).toEqual(['sara@acme.com']);
        expect(await updatedAt(client, id)).toBe(before);
        expect(got?.row.updatedBy).toBeNull();
      });
    });

    it('keeps earlier opt-outs and answers null for an unknown report', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const id = await repo.insert(
          values(workspaceId, { optedOut: ['b@acme.com'] }),
        );
        await repo.optOut(id, 'a@acme.com');
        expect((await repo.getById(id))?.row.optedOut).toEqual([
          'a@acme.com',
          'b@acme.com',
        ]);
        expect(
          await repo.optOut('00000000-0000-0000-0000-000000000000', 'a@b.co'),
        ).toBeNull();
      });
    });
  });

  describe('logo', () => {
    it('resolves a live image to its file_url, and a binned one to null', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const mediaId = await seedMedia(client, workspaceId, ownerId, {
          url: 'https://cdn.test/live.png',
        });
        const id = await repo.insert(
          values(workspaceId, { logoMediaId: mediaId }),
        );

        expect(await repo.logoUrl(workspaceId, mediaId)).toBe(
          'https://cdn.test/live.png',
        );
        expect((await repo.get(workspaceId, id))?.logoUrl).toBe(
          'https://cdn.test/live.png',
        );

        await client.query(
          `UPDATE media_items SET is_deleted = true WHERE id = $1`,
          [mediaId],
        );
        expect(await repo.logoUrl(workspaceId, mediaId)).toBeNull();
        const binned = await repo.get(workspaceId, id);
        expect(binned?.logoUrl).toBeNull();
        expect(binned?.row.logoMediaId).toBe(mediaId);
      });
    });

    it('treats a null is_deleted as live (the column is nullable)', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const mediaId = await seedMedia(client, workspaceId, ownerId, {
          isDeleted: null,
          url: 'https://cdn.test/null-flag.png',
        });
        const id = await repo.insert(
          values(workspaceId, { logoMediaId: mediaId }),
        );
        expect(await repo.logoUrl(workspaceId, mediaId)).toBe(
          'https://cdn.test/null-flag.png',
        );
        expect((await repo.get(workspaceId, id))?.logoUrl).toBe(
          'https://cdn.test/null-flag.png',
        );
        expect(await repo.logoItem(workspaceId, mediaId)).toEqual({
          type: 'image',
          mimeType: 'image/png',
          isDeleted: false,
        });
      });
    });

    it('never resolves another workspace media item, or no id at all', async () => {
      await run(async (repo, client) => {
        const a = await seedWorkspace(client);
        const b = await seedWorkspace(client);
        const theirs = await seedMedia(client, b.workspaceId, b.ownerId);
        expect(await repo.logoUrl(a.workspaceId, theirs)).toBeNull();
        expect(await repo.logoItem(a.workspaceId, theirs)).toBeNull();
        expect(await repo.logoUrl(a.workspaceId, null)).toBeNull();

        // A stored id that points into another workspace reads as no logo.
        const id = await repo.insert(
          values(a.workspaceId, { logoMediaId: theirs }),
        );
        expect((await repo.get(a.workspaceId, id))?.logoUrl).toBeNull();
      });
    });

    it('reports a binned item through logoItem, so the caller can refuse it', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const mediaId = await seedMedia(client, workspaceId, ownerId, {
          isDeleted: true,
          type: 'video',
        });
        expect(await repo.logoItem(workspaceId, mediaId)).toEqual({
          type: 'video',
          mimeType: 'image/png',
          isDeleted: true,
        });
      });
    });
  });

  describe('due', () => {
    const NOW = new Date('2026-11-13T12:00:00Z');
    const weekly = {
      cadence: 'weekly',
      weekday: 1,
      sendMinute: 540,
    } as const;

    it('picks scheduled reports at or before now, oldest slot first', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const later = await repo.insert(
          values(workspaceId, {
            ...weekly,
            nextRunAt: new Date('2026-11-13T08:00:00Z'),
          }),
        );
        const earlier = await repo.insert(
          values(workspaceId, {
            ...weekly,
            nextRunAt: new Date('2026-11-12T08:00:00Z'),
          }),
        );
        const exactly = await repo.insert(
          values(workspaceId, { ...weekly, nextRunAt: NOW }),
        );
        const due = await repo.due(NOW);
        expect(due.map((d) => d.id)).toEqual([earlier, later, exactly]);
        expect(due[0].nextRunAt).toEqual(new Date('2026-11-12T08:00:00Z'));
      });
    });

    it('skips the future, an unscheduled report and a suspended workspace', async () => {
      await run(async (repo, client) => {
        const live = await seedWorkspace(client);
        const suspended = await seedWorkspace(client);
        await client.query(
          `UPDATE workspace SET is_active = false WHERE id = $1`,
          [suspended.workspaceId],
        );
        const past = new Date('2026-11-12T08:00:00Z');
        const included = await repo.insert(
          values(live.workspaceId, { ...weekly, nextRunAt: past }),
        );
        await repo.insert(
          values(live.workspaceId, {
            ...weekly,
            nextRunAt: new Date('2026-11-14T08:00:00Z'),
          }),
        );
        await repo.insert(
          values(live.workspaceId, { cadence: null, nextRunAt: past }),
        );
        await repo.insert(
          values(suspended.workspaceId, { ...weekly, nextRunAt: past }),
        );
        expect((await repo.due(NOW)).map((d) => d.id)).toEqual([included]);
      });
    });

    it('stops at the limit', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        for (let i = 0; i < 3; i += 1) {
          await repo.insert(
            values(workspaceId, {
              ...weekly,
              nextRunAt: new Date(`2026-11-1${i}T08:00:00Z`),
            }),
          );
        }
        expect(await repo.due(NOW, 2)).toHaveLength(2);
      });
    });
  });

  describe('recordSent and recordError', () => {
    it('recordSent stamps the send, clears the error, advances the slot, and leaves updated_at', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const id = await seedAged(repo, client, workspaceId, {
          cadence: 'monthly',
          sendMinute: 540,
          lastError: 'boom',
          nextRunAt: new Date('2026-11-01T04:00:00Z'),
        });
        const before = await updatedAt(client, id);
        const sentAt = new Date('2026-11-01T04:00:05Z');
        const next = new Date('2026-12-01T04:00:00Z');

        await repo.recordSent(id, sentAt, next);

        const row = (await repo.getById(id))?.row;
        expect(row?.lastSentAt).toEqual(sentAt);
        expect(row?.lastError).toBeNull();
        expect(row?.nextRunAt).toEqual(next);
        expect(row?.updatedBy).toBeNull();
        expect(await updatedAt(client, id)).toBe(before);
      });
    });

    it('recordSent with no next slot leaves next_run_at as it was', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const slot = new Date('2026-11-01T04:00:00Z');
        const id = await repo.insert(
          values(workspaceId, {
            cadence: 'monthly',
            sendMinute: 540,
            nextRunAt: slot,
          }),
        );
        await repo.recordSent(id, new Date('2026-11-01T04:00:05Z'), undefined);
        expect((await repo.getById(id))?.row.nextRunAt).toEqual(slot);
      });
    });

    it('recordError stores the message, keeps last_sent_at, and leaves updated_at', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const sent = new Date('2026-10-01T04:00:00Z');
        const id = await seedAged(repo, client, workspaceId, {
          cadence: 'monthly',
          sendMinute: 540,
          lastSentAt: sent,
          nextRunAt: new Date('2026-11-01T04:00:00Z'),
        });
        const before = await updatedAt(client, id);
        const next = new Date('2026-12-01T04:00:00Z');

        await repo.recordError(id, 'No channels left in this report', next);

        const row = (await repo.getById(id))?.row;
        expect(row?.lastError).toBe('No channels left in this report');
        expect(row?.lastSentAt).toEqual(sent);
        expect(row?.nextRunAt).toEqual(next);
        expect(await updatedAt(client, id)).toBe(before);

        await repo.recordError(id, 'Later failure', undefined);
        expect((await repo.getById(id))?.row.nextRunAt).toEqual(next);
      });
    });

    it('recordError can stamp last_sent_at when some people got the report', async () => {
      await run(async (repo, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const id = await repo.insert(
          values(workspaceId, { cadence: 'monthly', sendMinute: 540 }),
        );
        const at = new Date('2026-11-01T04:00:30Z');
        await repo.recordError(id, 'Partly sent', undefined, undefined, at);
        const row = (await repo.getById(id))?.row;
        expect(row?.lastError).toBe('Partly sent');
        expect(row?.lastSentAt).toEqual(at);
      });
    });

    describe('with the slot the job read', () => {
      const SLOT = new Date('2026-11-01T04:00:00Z');
      const EDITED = new Date('2026-11-02T04:00:00Z');
      const NEXT = new Date('2026-12-01T04:00:00Z');

      async function seed(repo: ReportsRepository, workspaceId: string) {
        return repo.insert(
          values(workspaceId, {
            cadence: 'monthly',
            sendMinute: 540,
            lastError: 'old',
            nextRunAt: SLOT,
          }),
        );
      }

      it('writes while the slot is still the one read', async () => {
        await run(async (repo, client) => {
          const { workspaceId } = await seedWorkspace(client);
          const id = await seed(repo, workspaceId);
          const sentAt = new Date('2026-11-01T04:00:05Z');
          expect(await repo.recordSent(id, sentAt, NEXT, SLOT)).toBe(true);
          const row = (await repo.getById(id))?.row;
          expect(row?.nextRunAt).toEqual(NEXT);
          expect(row?.lastSentAt).toEqual(sentAt);
        });
      });

      it('does not overwrite a schedule changed while the job ran', async () => {
        await run(async (repo, client) => {
          const { workspaceId } = await seedWorkspace(client);
          const id = await seed(repo, workspaceId);
          // A PATCH moves the slot after the job read SLOT.
          await repo.update(workspaceId, id, { nextRunAt: EDITED });

          expect(
            await repo.recordSent(
              id,
              new Date('2026-11-01T04:00:05Z'),
              NEXT,
              SLOT,
            ),
          ).toBe(false);
          expect(await repo.recordError(id, 'boom', NEXT, SLOT)).toBe(false);

          const row = (await repo.getById(id))?.row;
          expect(row?.nextRunAt).toEqual(EDITED);
          expect(row?.lastSentAt).toBeNull();
          expect(row?.lastError).toBe('old');
        });
      });

      it('treats a null expected slot as "still unset"', async () => {
        await run(async (repo, client) => {
          const { workspaceId } = await seedWorkspace(client);
          const id = await repo.insert(values(workspaceId));
          expect(await repo.recordError(id, 'x', undefined, SLOT)).toBe(false);
          expect(await repo.recordError(id, 'x', undefined, null)).toBe(true);
        });
      });
    });
  });

  it('finds a report by share token, and not once the link is off', async () => {
    await run(async (repo, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const id = await repo.insert(
        values(workspaceId, { shareToken: 'tok-1' }),
      );

      expect((await repo.byShareToken('tok-1'))?.row.id).toBe(id);
      expect(await repo.byShareToken('other')).toBeNull();

      await repo.update(workspaceId, id, { shareToken: null });
      expect(await repo.byShareToken('tok-1')).toBeNull();
    });
  });
});
