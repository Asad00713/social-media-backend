import 'dotenv/config';
import { Client } from 'pg';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from './inbox-db';

describeInboxDb('inbox fixtures', () => {
  it('seeds a workspace, member, channel and dm, then rolls everything back', async () => {
    const ids = await withInboxDb(async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      const guestId = await seedMember(client, workspaceId, 'GUEST');
      const channelId = await seedChannel(client, workspaceId, 'instagram');
      const item = await seedItem(client, {
        workspaceId,
        channelId,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'c1',
        text: 'hi',
        platformCreatedAt: new Date(),
      });
      const inside = await client.query(
        `SELECT 1 FROM inbox_items WHERE id = $1`,
        [item.id],
      );
      expect(inside.rowCount).toBe(1);
      return { workspaceId, guestId, itemId: item.id };
    });

    const fresh = new Client({ connectionString: process.env.DATABASE_URL });
    await fresh.connect();
    try {
      const w = await fresh.query(`SELECT 1 FROM workspace WHERE id = $1`, [
        ids.workspaceId,
      ]);
      const i = await fresh.query(`SELECT 1 FROM inbox_items WHERE id = $1`, [
        ids.itemId,
      ]);
      const u = await fresh.query(`SELECT 1 FROM users WHERE id = $1`, [
        ids.guestId,
      ]);
      expect(w.rowCount).toBe(0);
      expect(i.rowCount).toBe(0);
      expect(u.rowCount).toBe(0);
    } finally {
      await fresh.end();
    }
  });
});
