import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { fetch as undiciFetch } from 'undici';
import {
  describeLibraryDb,
  withLibraryDb,
  seedWorkspace,
  seedLink,
} from '../testing/library-db';
import { SavedLinkService } from './saved-link.service';
import {
  CreateSavedLinkDto,
  UpdateSavedLinkDto,
  SavedLinkQueryDto,
} from '../dto/media-library.dto';

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

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

const PAGE = `<html><head><title>Hi</title>
<link rel="icon" href="/fav.png"></head></html>`;

describeLibraryDb('saved links: UTM, favicon, sort', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(() => Promise.resolve(new Response(PAGE)));
  });

  it('create stores normalised UTM and the favicon', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedLinkService(db);
      const dto = await toDto(CreateSavedLinkDto, {
        name: 'L',
        url: 'https://example.com/page',
        utm: { source: ' ig ', medium: '', campaign: 'x' },
      });
      const created = await svc.create(workspaceId, ownerId, dto);
      expect(created.utm).toEqual({ source: 'ig', campaign: 'x' });
      expect(created.previewFaviconUrl).toBe('https://example.com/fav.png');
    });
  });

  it('update with utm:null clears it', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedLinkService(db);
      const created = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateSavedLinkDto, {
          name: 'L',
          url: 'https://example.com/page',
          utm: { source: 'ig' },
        }),
      );
      expect(created.utm).toEqual({ source: 'ig' });
      const updated = await svc.update(
        workspaceId,
        created.id,
        await toDto(UpdateSavedLinkDto, { utm: null }),
      );
      expect(updated.utm).toBeNull();
    });
  });

  it('sort most_used orders by count; name orders case-insensitively', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const low = await seedLink(client, {
        ...base,
        name: 'beta',
        usageCount: 1,
      });
      const high = await seedLink(client, {
        ...base,
        name: 'Alpha',
        usageCount: 9,
      });
      const mid = await seedLink(client, {
        ...base,
        name: 'cherry',
        usageCount: 4,
      });
      const svc = new SavedLinkService(db);
      const used = await svc.findAll(workspaceId, { sort: 'most_used' });
      expect(used.items.map((l) => l.id)).toEqual([high, mid, low]);
      const named = await svc.findAll(workspaceId, { sort: 'name' });
      expect(named.items.map((l) => l.id)).toEqual([high, low, mid]);
    });
  });

  it('sort name orders a blank-named link by its preview title, not first', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const apple = await seedLink(client, { ...base, name: 'Apple' });
      const titled = await seedLink(client, {
        ...base,
        name: '',
        previewTitle: 'Banana page',
      });
      const bare = await seedLink(client, {
        ...base,
        name: '  ',
        url: 'https://cherry.example.test/',
      });
      const svc = new SavedLinkService(db);
      const named = await svc.findAll(workspaceId, { sort: 'name' });
      expect(named.items.map((l) => l.id)).toEqual([apple, titled, bare]);
    });
  });

  it("sort 'oldest' is created_at ASC, then id ASC", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const ids: Record<string, string> = {};
      for (const [key, iso] of [
        ['mid', '2026-03-01'],
        ['first', '2026-01-01'],
        ['tieA', '2026-05-01'],
        ['tieB', '2026-05-01'],
      ]) {
        ids[key] = await seedLink(client, base);
        await client.query(
          'UPDATE saved_links SET created_at = $2 WHERE id = $1',
          [ids[key], new Date(`${iso}T00:00:00Z`)],
        );
      }
      const query = await toDto(SavedLinkQueryDto, { sort: 'oldest' });

      const r = await new SavedLinkService(db).findAll(workspaceId, query);

      expect(r.items.map((l) => l.id)).toEqual([
        ids.first,
        ids.mid,
        ...[ids.tieA, ids.tieB].sort(),
      ]);
    });
  });

  it('does not store a favicon or fetch when the link is private', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedLinkService(db);
      const created = await svc.create(workspaceId, ownerId, {
        name: 'L',
        url: 'http://169.254.169.254/latest/meta-data',
      });
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(created.previewFaviconUrl).toBeNull();
    });
  });

  it('a failed re-fetch clears the old favicon (refresh and url change)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedLinkService(db);
      const created = await svc.create(workspaceId, ownerId, {
        name: 'L',
        url: 'https://example.com/page',
      });
      expect(created.previewFaviconUrl).toBe('https://example.com/fav.png');
      mockedFetch.mockImplementation(() =>
        Promise.resolve(new Response('x', { status: 500 })),
      );
      const refreshed = await svc.refreshPreview(workspaceId, created.id);
      expect(refreshed.previewFaviconUrl).toBeNull();

      mockedFetch.mockImplementation(() => Promise.resolve(new Response(PAGE)));
      await svc.refreshPreview(workspaceId, created.id);
      mockedFetch.mockImplementation(() =>
        Promise.resolve(new Response('x', { status: 500 })),
      );
      const moved = await svc.update(
        workspaceId,
        created.id,
        await toDto(UpdateSavedLinkDto, { url: 'https://other.example.com/' }),
      );
      expect(moved.previewFaviconUrl).toBeNull();
    });
  });
});
