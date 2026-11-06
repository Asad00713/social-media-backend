import { plainToInstance } from 'class-transformer';
import type { PoolClient } from 'pg';
import {
  describeLibraryDb,
  withLibraryDb,
  seedWorkspace,
  seedMember,
  seedCategory,
  seedMediaItem,
} from '../testing/library-db';
import { CreateCategoryDto } from '../dto/media-library.dto';
import type { UserRef } from '../dto/contract';
import { MediaLibraryController } from '../media-library.controller';
import { CategoryService } from './category.service';

const CREATOR_AVATAR = 'https://cdn.example.test/creator.png';

/** A workspace, plus a member (not the owner) who makes folders. */
async function seedTeam(client: PoolClient) {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const creatorId = await seedMember(client, workspaceId, 'MEMBER', {
    name: 'Creator',
  });
  await client.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [
    creatorId,
    CREATOR_AVATAR,
  ]);
  const creator: UserRef = {
    id: creatorId,
    name: 'Creator',
    avatarUrl: CREATOR_AVATAR,
  };
  return { workspaceId, ownerId, creatorId, creator };
}

/** A controller wired only with the folder service. */
function folderController(categories: CategoryService): MediaLibraryController {
  const unused = {} as never;
  return new MediaLibraryController(
    categories,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );
}

describeLibraryDb('migration 0056 (folder creator)', () => {
  it('adds a nullable created_by_id that a deleted user sets to NULL', async () => {
    await withLibraryDb(async (_db, client) => {
      const col = await client.query<{
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'media_categories' AND column_name = 'created_by_id'`,
      );
      expect(col.rows).toEqual([{ is_nullable: 'YES', data_type: 'uuid' }]);

      const { workspaceId } = await seedWorkspace(client);
      // A user with nothing else pointing at it, so it can be deleted alone.
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ($1, 'Gone') RETURNING id`,
        [`gone-${Date.now()}@example.test`],
      );
      const goneId = u.rows[0].id;
      const folder = await seedCategory(
        client,
        workspaceId,
        'media',
        'Shared',
        undefined,
        goneId,
      );

      await client.query(`DELETE FROM users WHERE id = $1`, [goneId]);

      const after = await client.query<{ created_by_id: string | null }>(
        `SELECT created_by_id FROM media_categories WHERE id = $1`,
        [folder],
      );
      // The folder stays (the team's), with no creator.
      expect(after.rows).toEqual([{ created_by_id: null }]);
    });
  });
});

describeLibraryDb('folders: createdBy', () => {
  it('a folder made through the route is created by the signed-in user', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, creatorId, creator } = await seedTeam(client);
      const controller = folderController(new CategoryService(db));

      const created = await controller.createCategory(
        workspaceId,
        { userId: creatorId },
        plainToInstance(CreateCategoryDto, { name: 'Launch', type: 'media' }),
      );

      expect(created.createdById).toBe(creatorId);
      expect(created.createdBy).toEqual(creator);
    });
  });

  it('every folder shape carries the creator', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, creatorId, creator } =
        await seedTeam(client);
      const svc = new CategoryService(db);
      const media = await svc.create(
        workspaceId,
        creatorId,
        plainToInstance(CreateCategoryDto, { name: 'Shots', type: 'media' }),
      );
      const links = await svc.create(
        workspaceId,
        creatorId,
        plainToInstance(CreateCategoryDto, { name: 'Refs', type: 'link' }),
      );
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        categoryId: media.id,
        fileSize: 10,
      });

      expect(media.createdBy).toEqual(creator);
      expect(links.createdBy).toEqual(creator);

      const list = await svc.findAll(workspaceId);
      expect(list.map((f) => [f.id, f.createdBy])).toEqual([
        [links.id, creator],
        [media.id, creator],
      ]);

      // Per-kind list (View all of one tab).
      const byKind = await svc.findAll(workspaceId, { type: 'link' });
      expect(byKind.map((f) => [f.id, f.createdBy])).toEqual([
        [links.id, creator],
      ]);

      // With stats the creator rides beside the stats, which still add up.
      const withStats = await svc.findAll(workspaceId, {
        type: 'media',
        withStats: true,
      });
      expect(withStats).toHaveLength(1);
      expect(withStats[0].createdBy).toEqual(creator);
      expect(withStats[0].stats).toMatchObject({ itemCount: 1, bytes: 10 });

      const grouped = await svc.findAllGroupedByType(workspaceId);
      expect(grouped.media.map((f) => f.createdBy)).toEqual([creator]);
      expect(grouped.link.map((f) => f.createdBy)).toEqual([creator]);

      expect((await svc.findOne(workspaceId, media.id)).createdBy).toEqual(
        creator,
      );

      // A rename by anyone keeps who made it.
      const renamed = await svc.update(workspaceId, media.id, {
        name: 'Renamed',
      });
      expect(renamed.name).toBe('Renamed');
      expect(renamed.createdBy).toEqual(creator);
    });
  });

  it('a folder made before 0056 has createdBy null in every shape', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedTeam(client);
      // seedCategory writes no creator, like every folder made before 0056.
      const old = await seedCategory(client, workspaceId, 'template', 'Old');
      const svc = new CategoryService(db);

      const [listed] = await svc.findAll(workspaceId);
      expect(listed).toMatchObject({ id: old, createdById: null });
      expect(listed.createdBy).toBeNull();

      const [stats] = await svc.findAll(workspaceId, { withStats: true });
      expect(stats.createdBy).toBeNull();
      expect(stats.stats).toEqual({ itemCount: 0, bytes: 0, covers: [] });

      const grouped = await svc.findAllGroupedByType(workspaceId);
      expect(grouped.template.map((f) => f.createdBy)).toEqual([null]);

      expect((await svc.findOne(workspaceId, old)).createdBy).toBeNull();
      const renamed = await svc.update(workspaceId, old, { name: 'Older' });
      expect(renamed.createdBy).toBeNull();
    });
  });

  it('a creator with no name shows the local part of their email', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedTeam(client);
      const noName = await seedMember(client, workspaceId, 'MEMBER', {
        email: 'sam.lee@example.test',
      });
      await client.query(`UPDATE users SET name = NULL WHERE id = $1`, [
        noName,
      ]);
      const svc = new CategoryService(db);

      const created = await svc.create(
        workspaceId,
        noName,
        plainToInstance(CreateCategoryDto, { name: 'Mine', type: 'media' }),
      );

      expect(created.createdBy).toEqual({
        id: noName,
        name: 'sam.lee',
        avatarUrl: null,
      });
    });
  });
});
