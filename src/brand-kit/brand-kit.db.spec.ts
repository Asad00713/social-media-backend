import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import {
  BrandKitService,
  isMissingTable,
  normaliseColors,
  normalisePresets,
} from './brand-kit.service';

const MIGRATION = '0059_brand_kits.sql';

type Client = {
  query: (
    sql: string,
    args?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

async function seedMedia(
  client: Client,
  workspaceId: string,
  userId: string,
  type = 'image',
): Promise<string> {
  const r = await client.query(
    `INSERT INTO media_items (workspace_id, uploaded_by_id, type, name, file_url, width, height)
     VALUES ($1, $2, $3, 'logo.png', 'https://cdn.test/logo.png', 400, 200) RETURNING id`,
    [workspaceId, userId, type],
  );
  return r.rows[0].id as string;
}

describe('brand kit normalisers', () => {
  it('lower-cases colours and drops repeats, keeping order', () => {
    expect(normaliseColors(['#FFAA00', '#112233', '#ffaa00'])).toEqual([
      '#ffaa00',
      '#112233',
    ]);
  });

  it('keeps only the seven sliders, as integers, and one preset per id', () => {
    expect(
      normalisePresets([
        {
          id: 'warm',
          name: ' Warm ',
          values: { warmth: 20.4, contrast: 0, bogus: 9, sharpen: 10 },
        },
        { id: 'warm', name: 'Again', values: {} },
      ]),
    ).toEqual([
      { id: 'warm', name: 'Warm', values: { warmth: 20, sharpen: 10 } },
    ]);
  });

  it('finds 42P01 on the error or its cause', () => {
    expect(isMissingTable({ cause: { code: '42P01' } })).toBe(true);
    expect(isMissingTable(new Error('x'))).toBe(false);
  });
});

describeDb('BrandKitService (database)', () => {
  it('starts empty, saves each field on its own, and tracks the logo', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new BrandKitService(db);

      expect(await svc.get(ws, 'MEMBER')).toEqual({
        colors: [],
        logo: null,
        adjustPresets: [],
        canEdit: false,
      });
      expect((await svc.get(ws, 'ADMIN')).canEdit).toBe(true);

      await svc.update(ws, ownerId, 'OWNER', { colors: ['#FFAA00'] });
      await svc.update(ws, ownerId, 'OWNER', {
        adjustPresets: [
          { id: 'p1', name: 'Warm', values: { warmth: 20 } },
        ] as never,
      });
      // A colour save leaves presets alone, and the other way round.
      const kit = await svc.get(ws, 'GUEST');
      expect(kit.colors).toEqual(['#ffaa00']);
      expect(kit.adjustPresets).toEqual([
        { id: 'p1', name: 'Warm', values: { warmth: 20 } },
      ]);

      const logoId = await seedMedia(client, ws, ownerId);
      const withLogo = await svc.update(ws, ownerId, 'OWNER', {
        logoMediaId: logoId,
      });
      expect(withLogo.logo).toEqual({
        mediaId: logoId,
        url: 'https://cdn.test/logo.png',
        name: 'logo.png',
        width: 400,
        height: 200,
      });
      expect(withLogo.colors).toEqual(['#ffaa00']);

      // Another workspace's image, or a video, is refused.
      const foreign = await seedMedia(client, other.workspaceId, other.ownerId);
      await expect(
        svc.update(ws, ownerId, 'OWNER', { logoMediaId: foreign }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const video = await seedMedia(client, ws, ownerId, 'video');
      await expect(
        svc.update(ws, ownerId, 'OWNER', { logoMediaId: video }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Binned in the Library: reads as no logo. Hard-deleted: SET NULL.
      await client.query(
        'UPDATE media_items SET is_deleted = true WHERE id = $1',
        [logoId],
      );
      expect((await svc.get(ws, 'OWNER')).logo).toBeNull();
      await client.query('DELETE FROM media_items WHERE id = $1', [logoId]);
      const after = await client.query<{ logo_media_id: string | null }>(
        'SELECT logo_media_id FROM workspace_brand_kits WHERE workspace_id = $1',
        [ws],
      );
      expect(after.rows[0].logo_media_id).toBeNull();

      // Clearing it explicitly works too.
      const again = await seedMedia(client, ws, ownerId);
      await svc.update(ws, ownerId, 'OWNER', { logoMediaId: again });
      expect(
        (await svc.update(ws, ownerId, 'OWNER', { logoMediaId: null })).logo,
      ).toBeNull();
      // The other workspace still has no kit.
      expect((await svc.get(other.workspaceId, 'OWNER')).colors).toEqual([]);
    });
  });

  it('the CHECKs keep both jsonb columns arrays', async () => {
    await withRollbackDb([MIGRATION], async (_db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      await client.query('SAVEPOINT s1');
      await expect(
        client.query(
          `INSERT INTO workspace_brand_kits (workspace_id, colors) VALUES ($1, '{}'::jsonb)`,
          [ws],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        client.query(
          `INSERT INTO workspace_brand_kits (workspace_id, adjust_presets) VALUES ($1, '"x"'::jsonb)`,
          [ws],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT s1');
    });
  });

  it('degrades before 0059 is applied: empty kit, clear 503 on write', async () => {
    await withRollbackDb([], async (db, client) => {
      const exists = await client.query<{ t: string | null }>(
        `SELECT to_regclass('workspace_brand_kits') AS t`,
      );
      expect(exists.rows[0].t).toBeNull();
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new BrandKitService(db);
      await client.query('SAVEPOINT s1');
      expect(await svc.get(ws, 'OWNER')).toMatchObject({
        colors: [],
        logo: null,
        canEdit: true,
      });
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        svc.update(ws, ownerId, 'OWNER', { colors: ['#000000'] }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
