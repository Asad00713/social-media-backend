import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedCategory,
} from '../testing/library-db';
import { CategoryService } from './category.service';
import { TextSnippetService } from './text-snippet.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateMediaItemDto,
  BulkActionDto,
  CreateTextSnippetDto,
  TextSnippetQueryDto,
} from '../dto/media-library.dto';

// B8: every body/query goes through plainToInstance + validate, exactly as
// the global ValidationPipe does, and the transformed instance is what the
// service receives.
async function toDto<T extends object>(
  cls: new () => T,
  raw: Record<string, unknown>,
): Promise<T> {
  const instance = plainToInstance(cls, raw);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  expect(errors).toEqual([]);
  return instance;
}

const itemRaw = (type: string, categoryId: string) => ({
  type,
  name: `${type}-file`,
  fileUrl: `https://cdn.example.test/${type}-file`,
  categoryId,
});

describeLibraryDb('folder kinds and snippet types', () => {
  it('stores a legacy image folder as media', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const svc = new CategoryService(db);
      const dto = await toDto(CreateCategoryDto, { name: 'A', type: 'image' });
      const created = await svc.create(workspaceId, dto);
      expect(created.type).toBe('media');
    });
  });

  it('files an image and a video into one media folder', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const folder = await seedCategory(client, workspaceId, 'media');
      const svc = makeMediaItemService(db);
      const img = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateMediaItemDto, itemRaw('image', folder)),
      );
      const vid = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateMediaItemDto, itemRaw('video', folder)),
      );
      expect([img.categoryId, vid.categoryId]).toEqual([folder, folder]);
    });
  });

  it('rejects an image filed into a template folder', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const folder = await seedCategory(client, workspaceId, 'template', 'Tpl');
      const svc = makeMediaItemService(db);
      await expect(
        svc.create(
          workspaceId,
          ownerId,
          await toDto(CreateMediaItemDto, itemRaw('image', folder)),
        ),
      ).rejects.toThrow('Folder "Tpl" is not a media folder');
    });
  });

  it('assertMediaFolder 404s outside the workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const folder = await seedCategory(client, a.workspaceId, 'media');
      const svc = makeMediaItemService(db);
      await expect(
        svc.assertMediaFolder(b.workspaceId, folder),
      ).rejects.toThrow('Folder not found');
    });
  });

  it('update refuses a template folder too', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const media = await seedCategory(client, workspaceId, 'media');
      const tpl = await seedCategory(client, workspaceId, 'template', 'Tpl');
      const svc = makeMediaItemService(db);
      const item = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateMediaItemDto, itemRaw('image', media)),
      );
      await expect(
        svc.update(workspaceId, item.id, { categoryId: tpl }),
      ).rejects.toThrow('Folder "Tpl" is not a media folder');
    });
  });

  it('bulk-moves an image and a gif into a media folder', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const folder = await seedCategory(client, workspaceId, 'media');
      const tpl = await seedCategory(client, workspaceId, 'template', 'Tpl');
      const svc = makeMediaItemService(db);
      const mk = async (type: string) =>
        (
          await svc.create(
            workspaceId,
            ownerId,
            await toDto(CreateMediaItemDto, {
              type,
              name: type,
              fileUrl: `https://cdn.example.test/${type}`,
            }),
          )
        ).id;
      const ids = [await mk('image'), await mk('gif')];
      const bad = await toDto(BulkActionDto, {
        ids,
        action: 'move',
        categoryId: tpl,
      });
      await expect(svc.bulkAction(workspaceId, ownerId, bad)).rejects.toThrow(
        'Folder "Tpl" is not a media folder',
      );
      const ok = await toDto(BulkActionDto, {
        ids,
        action: 'move',
        categoryId: folder,
      });
      await svc.bulkAction(workspaceId, ownerId, ok);
      const { rows } = await client.query<{ category_id: string }>(
        'SELECT category_id FROM media_items WHERE id = ANY($1)',
        [ids],
      );
      expect(rows.map((r) => r.category_id)).toEqual([folder, folder]);
    });
  });

  it('refuses a duplicate name per kind but reads pre-existing duplicates', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      await seedCategory(client, workspaceId, 'media', 'Launch');
      await seedCategory(client, workspaceId, 'media', 'Launch');
      const svc = new CategoryService(db);
      await expect(
        svc.create(
          workspaceId,
          await toDto(CreateCategoryDto, { name: 'Launch', type: 'video' }),
        ),
      ).rejects.toThrow('already exists');
      const grouped = await svc.findAllGroupedByType(workspaceId);
      expect(grouped.media).toHaveLength(2);
      expect(Object.keys(grouped).sort()).toEqual([
        'link',
        'media',
        'template',
        'text_snippet',
      ]);
    });
  });

  it('a category update cannot change the folder kind', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const folder = await seedCategory(client, workspaceId, 'media');
      const svc = new CategoryService(db);
      await expect(
        svc.update(
          workspaceId,
          folder,
          await toDto(UpdateCategoryDto, { type: 'template' }),
        ),
      ).rejects.toThrow("A folder's kind cannot change");
      // A legacy kind that normalises to the same kind is not a change.
      await svc.update(
        workspaceId,
        folder,
        await toDto(UpdateCategoryDto, { type: 'video', name: 'Renamed' }),
      );
    });
  });

  it('stores bio as signature and finds it by either name', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new TextSnippetService(db);
      const created = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateTextSnippetDto, {
          name: 'Sig',
          content: 'hello',
          snippetType: 'bio',
        }),
      );
      expect(created.snippetType).toBe('signature');

      const byType = await svc.findAll(
        workspaceId,
        await toDto(TextSnippetQueryDto, { type: 'signature' }),
      );
      expect(byType.items.map((i) => i.id)).toEqual([created.id]);
      const byLegacy = await svc.findAll(
        workspaceId,
        await toDto(TextSnippetQueryDto, { snippetType: 'bio' }),
      );
      expect(byLegacy.items.map((i) => i.id)).toEqual([created.id]);

      // type wins over snippetType
      const both = await svc.findAll(
        workspaceId,
        await toDto(TextSnippetQueryDto, {
          type: 'caption',
          snippetType: 'bio',
        }),
      );
      expect(both.items).toHaveLength(0);
    });
  });

  it('a plain caption validates (guards a broken transform)', async () => {
    await toDto(TextSnippetQueryDto, { snippetType: 'caption' });
    await toDto(CreateTextSnippetDto, {
      name: 'n',
      content: 'c',
      snippetType: 'caption',
    });
  });
});
