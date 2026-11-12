import { BadRequestException, HttpException } from '@nestjs/common';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedWorkspace } from '../../inbox/testing/inbox-db';
import {
  NETWORK_REQUESTS_PER_DAY,
  NetworkRequestsService,
} from './network-requests.service';

const MIGRATION = '0063_channel_pause_and_network_requests.sql';

describeDb('NetworkRequestsService (database)', () => {
  it('stores a trimmed request and returns it', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new NetworkRequestsService(db);
      const res = await svc.create(ws, ownerId, {
        network: '  Snapchat ',
        note: ' for our clients ',
      });
      expect(res).toMatchObject({
        network: 'Snapchat',
        note: 'for our clients',
      });
      const rows = await client.query(
        `SELECT workspace_id, user_id, network, note FROM network_requests WHERE id = $1`,
        [res.id],
      );
      expect(rows.rows[0]).toEqual({
        workspace_id: ws,
        user_id: ownerId,
        network: 'Snapchat',
        note: 'for our clients',
      });
      const blankNote = await svc.create(ws, ownerId, {
        network: 'Lemon8',
        note: '   ',
      });
      expect(blankNote.note).toBeNull();
    }));

  it('refuses an empty or oversized network', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new NetworkRequestsService(db);
      await expect(
        svc.create(ws, ownerId, { network: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.create(ws, ownerId, { network: 'x'.repeat(61) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.create(ws, ownerId, { network: 'ok', note: 'n'.repeat(501) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }));

  it('allows NETWORK_REQUESTS_PER_DAY per person per day, then 429', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new NetworkRequestsService(db);
      for (let i = 0; i < NETWORK_REQUESTS_PER_DAY; i++) {
        await svc.create(ws, ownerId, { network: `Net ${i}` });
      }
      const err = await svc
        .create(ws, ownerId, { network: 'one more' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      // Someone else is not affected.
      await expect(
        svc.create(other.workspaceId, other.ownerId, { network: 'Snapchat' }),
      ).resolves.toBeDefined();
      // Older than a day no longer counts.
      await client.query(
        `UPDATE network_requests SET created_at = now() - interval '25 hours' WHERE user_id = $1`,
        [ownerId],
      );
      await expect(
        svc.create(ws, ownerId, { network: 'again' }),
      ).resolves.toBeDefined();
    }));
});
