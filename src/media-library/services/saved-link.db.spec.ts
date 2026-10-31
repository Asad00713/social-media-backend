import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
} from '../dto/media-library.dto';

jest.mock('dns/promises', () => ({
  lookup: jest
    .fn()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

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
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.resolve(new Response(PAGE))) as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
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

  it('does not store a favicon or fetch when the link is private', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new SavedLinkService(db);
      const created = await svc.create(workspaceId, ownerId, {
        name: 'L',
        url: 'http://169.254.169.254/latest/meta-data',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(created.previewFaviconUrl).toBeNull();
    });
  });
});
