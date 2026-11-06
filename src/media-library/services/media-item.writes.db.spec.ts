import type { PoolClient } from 'pg';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedCategory,
  seedTemplate,
  seedSnippet,
  seedLink,
} from '../testing/library-db';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';
import type { MediaItemView } from './media-item.service';

/** An item filed in a media folder, so the view's joins have something. */
async function seedFiledItem(client: PoolClient) {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const categoryId = await seedCategory(client, workspaceId, 'media', 'Shots');
  const id = await seedMediaItem(client, {
    workspaceId,
    uploadedById: ownerId,
    categoryId,
  });
  return { workspaceId, ownerId, categoryId, id };
}

function expectView(
  view: MediaItemView,
  ids: { id: string; ownerId: string; categoryId: string },
) {
  expect(view.id).toBe(ids.id);
  expect(view.category).toMatchObject({ id: ids.categoryId, name: 'Shots' });
  expect(view.uploadedBy).toMatchObject({ id: ids.ownerId });
}

describeLibraryDb('single-item writes return the MediaItemView (M9)', () => {
  it('PUT items/:id returns the view with folder and uploader', async () => {
    await withLibraryDb(async (db, client) => {
      const ids = await seedFiledItem(client);
      const svc = makeMediaItemService(db);

      const view = await svc.update(ids.workspaceId, ids.id, { name: 'New' });

      expectView(view, ids);
      expect(view.name).toBe('New');
    });
  });

  it('softDelete, restore and markUsed return the view too', async () => {
    await withLibraryDb(async (db, client) => {
      const ids = await seedFiledItem(client);
      const svc = makeMediaItemService(db);

      const binned = await svc.softDelete(ids.workspaceId, ids.id, ids.ownerId);
      expectView(binned, ids);
      expect(binned.isDeleted).toBe(true);

      const restored = await svc.restore(ids.workspaceId, ids.id);
      expectView(restored, ids);
      expect(restored.isDeleted).toBe(false);

      const used = await svc.markUsed(ids.workspaceId, ids.id);
      expectView(used, ids);
      expect(used.lastUsedAt).not.toBeNull();
    });
  });
});

describeLibraryDb('bulk ids are de-duplicated (M10)', () => {
  it('items/bulk: a repeated id is a success, counted once', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const a = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      const b = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });

      const r = await makeMediaItemService(db).bulkAction(
        workspaceId,
        ownerId,
        {
          ids: [a, a, b, a],
          action: 'star',
        },
      );

      expect(r).toEqual({ affectedCount: 2 });
    });
  });

  it('templates, snippets and links bulk: a repeated id is a success, counted once', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const t = await seedTemplate(client, base);
      const s = await seedSnippet(client, base);
      const l = await seedLink(client, base);

      const rs = await Promise.all([
        new TemplateService(db).bulkAction(workspaceId, ownerId, {
          ids: [t, t],
          action: 'star',
        }),
        new TextSnippetService(db).bulkAction(workspaceId, ownerId, {
          ids: [s, s, s],
          action: 'delete',
        }),
        new SavedLinkService(db).bulkAction(workspaceId, ownerId, {
          ids: [l, l],
          action: 'unstar',
        }),
      ]);

      expect(rs).toEqual([
        { affectedCount: 1 },
        { affectedCount: 1 },
        { affectedCount: 1 },
      ]);
    });
  });
});
