import { Client } from 'pg';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedPost,
  seedCampaignSlot,
  seedEvergreenPost,
} from './library-db';

describeLibraryDb('library DB harness', () => {
  it('runs MediaItemService on the harness db and leaves no row behind', async () => {
    const name = `harness-${Math.random().toString(36).slice(2, 10)}.png`;

    const result = await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'image',
        name,
      });
      await seedPost(client, { workspaceId, createdById: ownerId });
      await seedCampaignSlot(client, {
        workspaceId,
        createdById: ownerId,
        media: [{ id: 'm1' }],
      });
      await seedEvergreenPost(client, {
        workspaceId,
        createdById: ownerId,
        media: [{ id: 'm2' }],
      });

      return makeMediaItemService(db).findAll(workspaceId);
    });

    expect(result.total).toBe(1);
    expect(result.items[0].name).toBe(name);

    const fresh = new Client({ connectionString: process.env.DATABASE_URL });
    await fresh.connect();
    try {
      const r = await fresh.query('SELECT 1 FROM media_items WHERE name = $1', [
        name,
      ]);
      expect(r.rowCount).toBe(0);
    } finally {
      await fresh.end();
    }
  });
});
