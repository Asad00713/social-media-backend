import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMediaItem,
  seedTemplate,
  seedSnippet,
  seedLink,
} from '../testing/library-db';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';

describeLibraryDb('library queries: tags filter and search', () => {
  it('tags filter requires every listed tag', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const a = await seedMediaItem(client, {
        ...base,
        tags: ['launch', 'q4'],
      });
      const b = await seedMediaItem(client, { ...base, tags: ['launch'] });
      await seedMediaItem(client, { ...base, tags: [] });
      const svc = makeMediaItemService(db);

      const both = await svc.findAll(workspaceId, {
        tags: ['launch', 'q4'],
      });
      expect(both.items.map((i) => i.id)).toEqual([a]);
      expect(both.total).toBe(1);

      const one = await svc.findAll(workspaceId, { tags: ['launch'] });
      expect(one.items.map((i) => i.id).sort()).toEqual([a, b].sort());
      expect(one.total).toBe(2);
    });
  });

  it('search is case-insensitive and treats % and _ literally', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      await seedMediaItem(client, { ...base, name: 'Summer SALE banner' });
      const pct = await seedMediaItem(client, {
        ...base,
        name: 'sale-50%-off',
      });
      const und = await seedMediaItem(client, { ...base, name: 'sale_50x' });
      const svc = makeMediaItemService(db);

      expect((await svc.findAll(workspaceId, { search: 'sale' })).total).toBe(
        3,
      );
      const p = await svc.findAll(workspaceId, { search: '50%' });
      expect(p.items.map((i) => i.id)).toEqual([pct]);
      const u = await svc.findAll(workspaceId, { search: '_50' });
      expect(u.items.map((i) => i.id)).toEqual([und]);
    });
  });

  it('templates, snippets and links search case-insensitively', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const t = await seedTemplate(client, {
        workspaceId,
        createdById: ownerId,
        name: 'Product Launch',
      });
      const s = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Link In Bio',
      });
      const l = await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        url: 'https://Example.com/A',
      });

      const templates = await new TemplateService(db).findAll(workspaceId, {
        search: 'launch',
      });
      expect(templates.items.map((i) => i.id)).toEqual([t]);

      const snippets = await new TextSnippetService(db).findAll(workspaceId, {
        search: 'in bio',
      });
      expect(snippets.items.map((i) => i.id)).toEqual([s]);

      const links = await new SavedLinkService(db).findAll(workspaceId, {
        search: 'example.com',
      });
      expect(links.items.map((i) => i.id)).toEqual([l]);
    });
  });
});
