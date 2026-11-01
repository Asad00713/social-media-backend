import { Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
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
import { MediaLibraryController } from '../media-library.controller';
import { BinItemsDto, RecycleBinQueryDto } from '../dto/media-library.dto';
import type { BinRow } from '../dto/contract';
import { CategoryService } from './category.service';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';
import { RecycleBinService } from './recycle-bin.service';
import { AltTextService } from './alt-text.service';
import { MediaUsageService } from './media-usage.service';
import { LibraryStatsService } from './library-stats.service';
import { CategoryZipService } from './category-zip.service';
import type { StorageObjectService } from './storage-object.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function setup(db: DbType) {
  const deleteFile = jest.fn().mockResolvedValue(undefined);
  const storageObjects = {
    deleteFile,
    findSharedFiles: jest.fn().mockResolvedValue({
      urls: new Set<string>(),
      publicIds: new Set<string>(),
    }),
    findReferencedItems: jest.fn().mockResolvedValue(new Set<string>()),
    // No row here has a poster, so purge discards none.
    posterRefOf: jest.fn().mockReturnValue(null),
  } as unknown as StorageObjectService;
  const media = makeMediaItemService(db, { storageObjects });
  const recycleBin = new RecycleBinService(db, media);
  const controller = new MediaLibraryController(
    new CategoryService(db),
    media,
    new TemplateService(db),
    new TextSnippetService(db),
    new SavedLinkService(db),
    recycleBin,
    {} as AltTextService,
    new MediaUsageService(db),
    new CategoryZipService(db, storageObjects),
    {} as LibraryStatsService,
  );
  return { deleteFile, media, recycleBin, controller };
}

async function toQuery(raw: Record<string, unknown>) {
  const dto = plainToInstance(RecycleBinQueryDto, raw);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

async function itemsErrors(raw: unknown) {
  const dto = plainToInstance(BinItemsDto, raw);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

async function isDeleted(
  client: PoolClient,
  table: string,
  id: string,
): Promise<boolean | null> {
  const r = await client.query<{ is_deleted: boolean }>(
    `SELECT is_deleted FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rowCount === 0 ? null : r.rows[0].is_deleted;
}

/**
 * Seven binned rows across the four kinds (distinct deleted_at, newest
 * first in the order below), one live item and one binned item in another
 * workspace.
 */
async function seedBin(client: PoolClient) {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const other = await seedWorkspace(client);
  await client.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [
    ownerId,
    'https://cdn.example.test/owner.png',
  ]);
  const t0 = Date.now() - 60 * 60 * 1000;
  const at = (s: number) => new Date(t0 + s * 1000);
  const del = (s: number) => ({
    isDeleted: true,
    deletedAt: at(s),
    deletedById: ownerId,
  });
  const media = { workspaceId, uploadedById: ownerId };
  const kind = { workspaceId, createdById: ownerId };

  const m10 = await seedMediaItem(client, {
    ...media,
    ...del(7),
    name: 'delta',
    type: 'image',
    fileSize: 10,
    fileUrl: 'https://cdn.example.test/m10.png',
  });
  const m30 = await seedMediaItem(client, {
    ...media,
    ...del(6),
    name: 'Alpha',
    type: 'image',
    fileSize: 30,
    thumbnailUrl: 'https://cdn.example.test/m30-thumb.png',
  });
  const mNull = await seedMediaItem(client, {
    ...media,
    ...del(5),
    name: 'echo',
    type: 'video',
    fileSize: null,
  });
  const tpl1 = await seedTemplate(client, {
    ...kind,
    ...del(4),
    name: 'bravo',
    thumbnailUrl: 'https://cdn.example.test/tpl1.png',
  });
  const tpl2 = await seedTemplate(client, { ...kind, ...del(3), name: 'golf' });
  const snip = await seedSnippet(client, {
    ...kind,
    ...del(2),
    name: 'charlie',
  });
  const link = await seedLink(client, {
    ...kind,
    ...del(1),
    name: 'foxtrot',
    previewImageUrl: 'https://cdn.example.test/link.png',
  });
  const live = await seedMediaItem(client, { ...media, name: 'live' });
  const foreign = await seedMediaItem(client, {
    workspaceId: other.workspaceId,
    uploadedById: other.ownerId,
    isDeleted: true,
    deletedAt: at(9),
  });

  return {
    workspaceId,
    ownerId,
    other,
    at,
    ids: { m10, m30, mNull, tpl1, tpl2, snip, link, live, foreign },
  };
}

describe('bin DTOs', () => {
  it('validates the bin query', async () => {
    expect((await toQuery({ kind: 'snippet', sort: 'size' })).errors).toEqual(
      [],
    );
    expect((await toQuery({ kind: 'text_snippet' })).errors).not.toEqual([]);
    expect((await toQuery({ sort: 'newest' })).errors).not.toEqual([]);
    expect((await toQuery({ limit: '101' })).errors).not.toEqual([]);
    expect((await toQuery({ limit: '0' })).errors).not.toEqual([]);
    expect((await toQuery({ type: 'video' })).errors).toEqual([]);
  });

  it('validates the restore / delete body', async () => {
    const id = '7b0b7f8e-3c1a-4c55-9d1e-1f2a3b4c5d6e';
    expect(await itemsErrors({ items: [{ kind: 'media', id }] })).toEqual([]);
    expect(await itemsErrors({ items: [] })).not.toEqual([]);
    expect(
      await itemsErrors({ items: [{ kind: 'text_snippet', id }] }),
    ).not.toEqual([]);
    expect(
      await itemsErrors({ items: [{ kind: 'media', id: 'nope' }] }),
    ).not.toEqual([]);
    const tooMany = Array.from({ length: 501 }, () => ({ kind: 'link', id }));
    expect(await itemsErrors({ items: tooMany })).not.toEqual([]);
  });
});

describeLibraryDb('recycle bin: one list across kinds', () => {
  it('lists every kind, newest deletion first, with counts per kind', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);

      const page = await recycleBin.list(workspaceId, {});

      expect(page.total).toBe(7);
      expect(page.limit).toBe(50);
      expect(page.offset).toBe(0);
      expect(page.items.map((r) => r.id)).toEqual([
        ids.m10,
        ids.m30,
        ids.mNull,
        ids.tpl1,
        ids.tpl2,
        ids.snip,
        ids.link,
      ]);
      expect(page.countsByKind).toEqual({
        media: 3,
        template: 2,
        snippet: 1,
        link: 1,
      });
    });
  });

  it('shapes each kind as a BinRow', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, at, ids } = await seedBin(client);
      const { recycleBin } = setup(db);

      const { items } = await recycleBin.list(workspaceId, {});
      const byId = new Map<string, BinRow>(items.map((r) => [r.id, r]));
      const deletedBy = {
        id: ownerId,
        name: 'Owner',
        avatarUrl: 'https://cdn.example.test/owner.png',
      };
      const times = (s: number) => ({
        deletedAt: at(s).toISOString(),
        purgeAt: new Date(at(s).getTime() + 30 * DAY_MS).toISOString(),
      });

      // An image with no thumbnail shows its own file.
      expect(byId.get(ids.m10)).toEqual({
        kind: 'media',
        id: ids.m10,
        name: 'delta',
        thumbnailUrl: 'https://cdn.example.test/m10.png',
        type: 'image',
        sizeBytes: 10,
        deletedBy,
        ...times(7),
      });
      expect(byId.get(ids.m30)?.thumbnailUrl).toBe(
        'https://cdn.example.test/m30-thumb.png',
      );
      // A video with no thumbnail has none: its file is not an image.
      expect(byId.get(ids.mNull)).toMatchObject({
        type: 'video',
        thumbnailUrl: null,
        sizeBytes: null,
      });
      expect(byId.get(ids.tpl1)).toEqual({
        kind: 'template',
        id: ids.tpl1,
        name: 'bravo',
        thumbnailUrl: 'https://cdn.example.test/tpl1.png',
        type: 'template',
        sizeBytes: null,
        deletedBy,
        ...times(4),
      });
      expect(byId.get(ids.snip)).toEqual({
        kind: 'snippet',
        id: ids.snip,
        name: 'charlie',
        thumbnailUrl: null,
        type: 'snippet',
        sizeBytes: null,
        deletedBy,
        ...times(2),
      });
      expect(byId.get(ids.link)).toEqual({
        kind: 'link',
        id: ids.link,
        name: 'foxtrot',
        thumbnailUrl: 'https://cdn.example.test/link.png',
        type: 'link',
        sizeBytes: null,
        deletedBy,
        ...times(1),
      });
    });
  });

  it('shows deletedBy null when nobody is recorded', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { recycleBin } = setup(db);
      await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      });

      const { items } = await recycleBin.list(workspaceId, {});

      expect(items).toHaveLength(1);
      expect(items[0].deletedBy).toBeNull();
    });
  });

  it('filters by kind before paging; counts ignore the kind', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);

      const page = await recycleBin.list(workspaceId, {
        kind: 'media',
        limit: 2,
      });

      expect(page.items.map((r) => r.id)).toEqual([ids.m10, ids.m30]);
      expect(page.total).toBe(3);
      expect(page.countsByKind).toEqual({
        media: 3,
        template: 2,
        snippet: 1,
        link: 1,
      });

      const rest = await recycleBin.list(workspaceId, {
        kind: 'media',
        limit: 2,
        offset: 2,
      });
      expect(rest.items.map((r) => r.id)).toEqual([ids.mNull]);
      expect(rest.total).toBe(3);
    });
  });

  it('filters a legacy media type before paging (through the route)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const { controller } = setup(db);
      const base = { workspaceId, uploadedById: ownerId, isDeleted: true };
      const t0 = Date.now() - 10 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        await seedMediaItem(client, {
          ...base,
          type: 'video',
          deletedAt: new Date(t0 + i * 1000),
        });
      }
      for (let i = 0; i < 60; i++) {
        await seedMediaItem(client, {
          ...base,
          type: 'image',
          deletedAt: new Date(t0 + 60_000 + i * 1000),
        });
      }
      await seedTemplate(client, {
        workspaceId,
        createdById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      });

      const { dto, errors } = await toQuery({ type: 'video', limit: '50' });
      expect(errors).toEqual([]);
      const result = await controller.getRecycleBin(workspaceId, dto);

      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.items.every((i) => i.type === 'video')).toBe(true);
    });
  });

  it('maps every legacy type to its kind; an explicit kind wins', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);
      const kindsOf = async (q: RecycleBinQueryDto) => [
        ...new Set(
          (await recycleBin.list(workspaceId, q)).items.map((r) => r.kind),
        ),
      ];

      expect(await kindsOf({ type: 'video' })).toEqual(['media']);
      expect(
        (await recycleBin.list(workspaceId, { type: 'video' })).items.map(
          (r) => r.id,
        ),
      ).toEqual([ids.mNull]);
      expect(await kindsOf({ type: 'template' })).toEqual(['template']);
      expect(await kindsOf({ type: 'text_snippet' })).toEqual(['snippet']);
      expect(await kindsOf({ type: 'link' })).toEqual(['link']);
      expect(await kindsOf({ type: 'video', kind: 'link' })).toEqual(['link']);
    });
  });

  it('sorts by size (nulls last, by deletion) and by name', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);

      const bySize = await recycleBin.list(workspaceId, { sort: 'size' });
      expect(bySize.items.map((r) => r.id)).toEqual([
        ids.m30,
        ids.m10,
        ids.mNull,
        ids.tpl1,
        ids.tpl2,
        ids.snip,
        ids.link,
      ]);

      const byName = await recycleBin.list(workspaceId, { sort: 'name' });
      expect(byName.items.map((r) => r.name)).toEqual([
        'Alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
      ]);
    });
  });
});

describeLibraryDb('recycle bin: a link with no name', () => {
  it('lists it under its preview title, else its URL, and sorts by that', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = {
        workspaceId,
        createdById: ownerId,
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: ownerId,
      };
      const titled = await seedLink(client, {
        ...base,
        name: '',
        previewTitle: 'Beta page',
      });
      const spaced = await seedLink(client, {
        ...base,
        name: '   ',
        previewTitle: '  ',
        url: 'https://zeta.example.test/x',
      });
      const named = await seedLink(client, {
        ...base,
        name: 'Alpha',
        previewTitle: 'Ignored',
      });
      const { recycleBin } = setup(db);

      const byName = await recycleBin.list(workspaceId, { sort: 'name' });
      expect(byName.items.map((r) => [r.id, r.name])).toEqual([
        [named, 'Alpha'],
        [titled, 'Beta page'],
        [spaced, 'https://zeta.example.test/x'],
      ]);
    });
  });
});

describeLibraryDb('recycle bin: bulk restore and delete forever', () => {
  afterEach(() => jest.restoreAllMocks());

  it('restores only binned rows of this workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);
      const liveLink = await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        name: 'live link',
      });

      const result = await recycleBin.restore(workspaceId, [
        { kind: 'media', id: ids.m10 },
        { kind: 'snippet', id: ids.snip },
        { kind: 'link', id: liveLink },
        { kind: 'media', id: ids.foreign },
      ]);

      expect(result).toEqual({ restored: 2 });
      const m10 = await client.query(
        'SELECT is_deleted, deleted_at, deleted_by_id FROM media_items WHERE id = $1',
        [ids.m10],
      );
      expect(m10.rows[0]).toEqual({
        is_deleted: false,
        deleted_at: null,
        deleted_by_id: null,
      });
      expect(await isDeleted(client, 'text_snippets', ids.snip)).toBe(false);
      expect(await isDeleted(client, 'saved_links', liveLink)).toBe(false);
      // Another workspace's row is never touched.
      expect(await isDeleted(client, 'media_items', ids.foreign)).toBe(true);
      // The rest of the bin stays put.
      expect(await isDeleted(client, 'media_templates', ids.tpl1)).toBe(true);
    });
  });

  it('a kind mismatch restores nothing', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin } = setup(db);

      // A media id sent as a template is looked up in templates only.
      const result = await recycleBin.restore(workspaceId, [
        { kind: 'template', id: ids.m10 },
      ]);

      expect(result).toEqual({ restored: 0 });
      expect(await isDeleted(client, 'media_items', ids.m10)).toBe(true);
    });
  });

  it('deletes media through the purge and the other kinds directly', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin, deleteFile } = setup(db);

      const result = await recycleBin.deleteForever(workspaceId, [
        { kind: 'media', id: ids.m10 },
        { kind: 'template', id: ids.tpl1 },
      ]);

      expect(result).toEqual({ deleted: 2 });
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: ids.m10 }),
      );
      expect(await isDeleted(client, 'media_items', ids.m10)).toBeNull();
      expect(await isDeleted(client, 'media_templates', ids.tpl1)).toBeNull();
      expect(await isDeleted(client, 'media_templates', ids.tpl2)).toBe(true);
    });
  });

  it('never deletes a live row or another workspace row, of any kind', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, other, ids } = await seedBin(client);
      const { recycleBin, deleteFile } = setup(db);
      const kind = { workspaceId, createdById: ownerId };
      const liveTpl = await seedTemplate(client, kind);
      const liveSnip = await seedSnippet(client, kind);
      const liveLink = await seedLink(client, kind);
      const foreignLink = await seedLink(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        isDeleted: true,
        deletedAt: new Date(),
      });

      const result = await recycleBin.deleteForever(workspaceId, [
        { kind: 'media', id: ids.live },
        { kind: 'media', id: ids.foreign },
        { kind: 'template', id: liveTpl },
        { kind: 'snippet', id: liveSnip },
        { kind: 'link', id: liveLink },
        { kind: 'link', id: foreignLink },
      ]);

      expect(result).toEqual({ deleted: 0 });
      expect(deleteFile).not.toHaveBeenCalled();
      expect(await isDeleted(client, 'media_items', ids.live)).toBe(false);
      expect(await isDeleted(client, 'media_items', ids.foreign)).toBe(true);
      expect(await isDeleted(client, 'media_templates', liveTpl)).toBe(false);
      expect(await isDeleted(client, 'text_snippets', liveSnip)).toBe(false);
      expect(await isDeleted(client, 'saved_links', liveLink)).toBe(false);
      expect(await isDeleted(client, 'saved_links', foreignLink)).toBe(true);
    });
  });

  it('keeps a media row whose file will not delete', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ids } = await seedBin(client);
      const { recycleBin, deleteFile } = setup(db);
      deleteFile.mockRejectedValue(new Error('storage down'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = await recycleBin.deleteForever(workspaceId, [
        { kind: 'media', id: ids.m10 },
        { kind: 'snippet', id: ids.snip },
      ]);

      expect(result).toEqual({ deleted: 1 });
      expect(await isDeleted(client, 'media_items', ids.m10)).toBe(true);
      expect(await isDeleted(client, 'text_snippets', ids.snip)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        `Failed to delete file for media item ${ids.m10}: storage down`,
      );
      expect(warn).toHaveBeenCalledWith(
        `Deleting from bin of workspace ${workspaceId}: 1 media items kept (file deletion failed)`,
      );
    });
  });
});

describeLibraryDb(
  'recycle bin: the cleanup honours the purgeAt the Bin shows',
  () => {
    afterEach(() => jest.restoreAllMocks());

    it('purges a legacy row with no deleted_at by updated_at, all four kinds', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const now = new Date();
        const old = new Date(now.getTime() - 31 * DAY_MS);
        const recent = new Date(now.getTime() - 29 * DAY_MS);
        const legacy = { isDeleted: true, deletedAt: null };
        const kind = { workspaceId, createdById: ownerId, ...legacy };
        const media = { workspaceId, uploadedById: ownerId, ...legacy };
        const rows: Record<string, [string, string]> = {
          mediaOld: ['media_items', await seedMediaItem(client, media)],
          mediaRecent: ['media_items', await seedMediaItem(client, media)],
          templateOld: ['media_templates', await seedTemplate(client, kind)],
          templateRecent: ['media_templates', await seedTemplate(client, kind)],
          snippetOld: ['text_snippets', await seedSnippet(client, kind)],
          snippetRecent: ['text_snippets', await seedSnippet(client, kind)],
          linkOld: ['saved_links', await seedLink(client, kind)],
          linkRecent: ['saved_links', await seedLink(client, kind)],
        };
        for (const [key, [table, id]] of Object.entries(rows)) {
          await client.query(
            `UPDATE ${table} SET updated_at = $2, deleted_at = NULL WHERE id = $1`,
            [id, key.endsWith('Old') ? old : recent],
          );
        }
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);
        const { recycleBin, media: mediaService } = setup(db);

        // The Bin shows these rows with purgeAt = updated_at + 30 days.
        const shown = await recycleBin.list(workspaceId, {});
        expect(
          shown.items.find((r) => r.id === rows.mediaOld[1])?.purgeAt,
        ).toBe(new Date(old.getTime() + 30 * DAY_MS).toISOString());

        // The cleanup is global (every workspace), so a local database's own
        // binned rows may be purged too: assert on these rows, not on counts.
        await mediaService.cleanupRecycleBin(now);
        await new TemplateService(db).cleanupRecycleBin(now);
        await new TextSnippetService(db).cleanupRecycleBin(now);
        await new SavedLinkService(db).cleanupRecycleBin(now);

        for (const [key, [table, id]] of Object.entries(rows)) {
          expect([key, await isDeleted(client, table, id)]).toEqual([
            key,
            key.endsWith('Old') ? null : true,
          ]);
        }
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^Cleaned up \d+ templates from recycle bin/),
        );
      });
    });
  },
);

describeLibraryDb('single-item permanent delete: Bin rows only', () => {
  afterEach(() => jest.restoreAllMocks());

  const KINDS = [
    {
      kind: 'template',
      table: 'media_templates',
      seed: seedTemplate,
      remove: (db: DbType, ws: string, id: string) =>
        new TemplateService(db).permanentDelete(ws, id),
    },
    {
      kind: 'snippet',
      table: 'text_snippets',
      seed: seedSnippet,
      remove: (db: DbType, ws: string, id: string) =>
        new TextSnippetService(db).permanentDelete(ws, id),
    },
    {
      kind: 'link',
      table: 'saved_links',
      seed: seedLink,
      remove: (db: DbType, ws: string, id: string) =>
        new SavedLinkService(db).permanentDelete(ws, id),
    },
  ] as const;

  it.each(KINDS)(
    '$kind: a live row is a 404 and stays; a binned row goes',
    async ({ table, seed, remove }) => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const live = await seed(client, { workspaceId, createdById: ownerId });
        const binned = await seed(client, {
          workspaceId,
          createdById: ownerId,
          isDeleted: true,
          deletedAt: new Date(),
        });
        const foreign = await seed(client, {
          workspaceId: other.workspaceId,
          createdById: other.ownerId,
          isDeleted: true,
          deletedAt: new Date(),
        });
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);

        await expect(remove(db, workspaceId, live)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(await isDeleted(client, table, live)).toBe(false);
        await expect(remove(db, workspaceId, foreign)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(await isDeleted(client, table, foreign)).toBe(true);

        await remove(db, workspaceId, binned);
        expect(await isDeleted(client, table, binned)).toBeNull();
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Permanently deleted`),
        );
      });
    },
  );
});
