import type { PoolClient } from 'pg';
import { fetch as undiciFetch } from 'undici';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  ownCloudinaryFile,
  seedWorkspace,
  seedPost,
  seedLink,
  seedSnippet,
} from '../testing/library-db';
import { SavedLinkService } from './saved-link.service';
import { TextSnippetService } from './text-snippet.service';

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

async function usage(
  client: PoolClient,
  table: 'media_items' | 'saved_links' | 'text_snippets',
  id: string,
): Promise<number | null> {
  const r = await client.query<{ usage_count: number | null }>(
    `SELECT usage_count FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0].usage_count;
}

describeLibraryDb('usage_count recount on Library writes (I4)', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(() =>
      Promise.resolve(new Response('<html><title>x</title></html>')),
    );
  });

  it('a link saved after a post already holds its URL counts that post', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const url = `https://shop.example/p-${Date.now()}`;
      const base = { workspaceId, createdById: ownerId };
      await seedPost(client, { ...base, content: `Buy now ${url}?utm=ig` });
      await seedPost(client, { ...base, content: `Again: (${url}).` });
      await seedPost(client, { ...base, content: `Not it: ${url}ing` });
      // Another workspace's post never counts.
      await seedPost(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        content: url,
      });

      const created = await new SavedLinkService(db).create(
        workspaceId,
        ownerId,
        { name: 'L', url },
      );

      expect(created.usageCount).toBe(2);
      expect(await usage(client, 'saved_links', created.id)).toBe(2);
    });
  });

  it("changing a link's URL recounts it", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const oldUrl = `https://shop.example/old-${Date.now()}`;
      const newUrl = `https://shop.example/new-${Date.now()}`;
      const base = { workspaceId, createdById: ownerId };
      const id = await seedLink(client, { ...base, url: oldUrl });
      await seedPost(client, { ...base, content: `See ${oldUrl}` });
      await seedPost(client, { ...base, content: `See ${newUrl}` });
      await seedPost(client, { ...base, content: `And ${newUrl}` });
      // The trigger counted it against the old URL when the posts were saved.
      expect(await usage(client, 'saved_links', id)).toBe(1);

      const svc = new SavedLinkService(db);
      const moved = await svc.update(workspaceId, id, { url: newUrl });

      expect(moved.usageCount).toBe(2);
      expect(await usage(client, 'saved_links', id)).toBe(2);
    });
  });

  it("changing a snippet's content recounts it", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const tag = `zq${Date.now()}`;
      const id = await seedSnippet(client, { ...base, content: `#${tag}old` });
      await seedPost(client, { ...base, content: `Hello #${tag}old` });
      await seedPost(client, { ...base, content: `Hey #${tag}new there` });
      await seedPost(client, { ...base, content: `#${tag}new!` });
      expect(await usage(client, 'text_snippets', id)).toBe(1);

      const svc = new TextSnippetService(db);
      const changed = await svc.update(workspaceId, id, {
        content: ` #${tag}new `,
      });

      expect(changed.usageCount).toBe(2);
      expect(await usage(client, 'text_snippets', id)).toBe(2);
    });
  });

  it('a snippet created after posts hold its text counts them; under 3 characters counts 0', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const tag = `zq${Date.now()}`;
      await seedPost(client, { ...base, content: `Sign-off ${tag}` });
      const svc = new TextSnippetService(db);

      const long = await svc.create(workspaceId, ownerId, {
        name: 'S',
        snippetType: 'signature',
        content: tag,
      });
      const short = await svc.create(workspaceId, ownerId, {
        name: 'T',
        snippetType: 'other',
        content: 'Si',
      });

      expect(long.usageCount).toBe(1);
      expect(short.usageCount).toBe(0);
    });
  });

  it('a media item registered for a file URL already used in posts counts them', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const file = ownCloudinaryFile(workspaceId);
      const base = { workspaceId, createdById: ownerId };
      await seedPost(client, {
        ...base,
        mediaItems: [{ url: file.fileUrl, type: 'image' }],
      });
      await seedPost(client, {
        ...base,
        platformContent: {
          instagram: { mediaItems: [{ url: file.fileUrl, type: 'image' }] },
        },
      });

      const item = await makeMediaItemService(db).create(workspaceId, ownerId, {
        type: 'image',
        name: 'Re-registered',
        ...file,
      });

      expect(item.usageCount).toBe(2);
      expect(await usage(client, 'media_items', item.id)).toBe(2);
    });
  });
});
