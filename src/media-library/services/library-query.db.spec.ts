import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { DbType } from '../../planner/testing/rollback-db';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedMember,
  seedMediaItem,
  seedTemplate,
  seedSnippet,
  seedLink,
  seedCategory,
  seedPost,
  seedCampaignSlot,
} from '../testing/library-db';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';
import {
  BulkActionDto,
  CreateMediaItemDto,
  LinkBulkDto,
  MediaItemQueryDto,
  SnippetBulkDto,
  TemplateBulkDto,
  UpdateMediaItemDto,
} from '../dto/media-library.dto';

// B8: bodies and queries go through plainToInstance + validate, as the global
// ValidationPipe does, and the transformed instance reaches the service.
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

async function validationErrors<T extends object>(
  cls: new () => T,
  raw: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

/** Inserts `n` media items in one statement; returns their ids. */
async function seedManyItems(
  client: PoolClient,
  workspaceId: string,
  uploadedById: string,
  n: number,
  type: 'image' | 'video' = 'image',
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_items (workspace_id, uploaded_by_id, type, name, file_url)
     SELECT $1, $2, $3, 'bulk-' || g, 'https://cdn.example.test/bulk-' || g || '-' || $4
     FROM generate_series(1, $5::int) g
     RETURNING id`,
    [workspaceId, uploadedById, type, Math.random().toString(36).slice(2), n],
  );
  return r.rows.map((row) => row.id);
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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

describeLibraryDb('library queries: item filters and sorts', () => {
  it("type 'images' is image + gif, gifOnly is gif only", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const img = await seedMediaItem(client, { ...base, type: 'image' });
      const gif = await seedMediaItem(client, { ...base, type: 'gif' });
      await seedMediaItem(client, { ...base, type: 'video' });
      const svc = makeMediaItemService(db);

      const images = await svc.findAll(workspaceId, { type: 'images' });
      expect(images.items.map((i) => i.id).sort()).toEqual([img, gif].sort());
      expect(images.total).toBe(2);

      const gifs = await svc.findAll(workspaceId, { gifOnly: true });
      expect(gifs.items.map((i) => i.id)).toEqual([gif]);
    });
  });

  it("ratio '4:5' matches within 3% and skips rows without dimensions", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const exact = await seedMediaItem(client, {
        ...base,
        width: 1080,
        height: 1350,
      });
      const near = await seedMediaItem(client, {
        ...base,
        width: 1080,
        height: 1349,
      });
      await seedMediaItem(client, { ...base, width: 1080, height: 1080 });
      await seedMediaItem(client, { ...base, width: null, height: null });
      await seedMediaItem(client, { ...base, width: 0, height: 0 });
      const svc = makeMediaItemService(db);

      const r = await svc.findAll(workspaceId, { ratio: '4:5' });
      expect(r.items.map((i) => i.id).sort()).toEqual([exact, near].sort());
      expect(r.total).toBe(2);
    });
  });

  it('addedSince and uploadedBy filter', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER');
      const old = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        createdAt: day('2026-01-01'),
      });
      const recent = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        createdAt: day('2026-06-01'),
      });
      const byMember = await seedMediaItem(client, {
        workspaceId,
        uploadedById: memberId,
        createdAt: day('2026-03-01'),
      });
      const svc = makeMediaItemService(db);

      const since = await svc.findAll(workspaceId, {
        addedSince: '2026-03-01T00:00:00Z',
      });
      expect(since.items.map((i) => i.id)).toEqual([recent, byMember]);

      const mine = await svc.findAll(workspaceId, { uploadedBy: ownerId });
      expect(mine.items.map((i) => i.id)).toEqual([recent, old]);

      const theirs = await svc.findAll(workspaceId, { uploadedBy: memberId });
      expect(theirs.items.map((i) => i.id)).toEqual([byMember]);
    });
  });

  it('neverUsed excludes items a post or a campaign slot uses', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const inPost = await seedMediaItem(client, base);
      const inSlot = await seedMediaItem(client, base);
      const unused = await seedMediaItem(client, base);
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        mediaItems: [
          {
            url: 'https://cdn.example.test/other.png',
            type: 'image',
            libraryItemId: inPost,
          },
        ],
      });
      await seedCampaignSlot(client, {
        workspaceId,
        createdById: ownerId,
        media: [{ id: inSlot }],
      });
      const svc = makeMediaItemService(db);

      const r = await svc.findAll(workspaceId, { neverUsed: true });
      expect(r.items.map((i) => i.id)).toEqual([unused]);
      expect(r.total).toBe(1);

      const all = await svc.findAll(workspaceId, { neverUsed: false });
      expect(all.total).toBe(3);
    });
  });

  it("sort 'size' is largest first with unknown sizes last", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const small = await seedMediaItem(client, { ...base, fileSize: 100 });
      const none = await seedMediaItem(client, { ...base, fileSize: null });
      const big = await seedMediaItem(client, { ...base, fileSize: 300 });
      const svc = makeMediaItemService(db);

      const r = await svc.findAll(workspaceId, { sort: 'size' });
      expect(r.items.map((i) => i.id)).toEqual([big, small, none]);
    });
  });

  it("sort 'recently_used' and legacy sortBy 'lastUsedAt' put nulls last", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const older = await seedMediaItem(client, {
        ...base,
        lastUsedAt: day('2026-02-01'),
      });
      const never = await seedMediaItem(client, { ...base, lastUsedAt: null });
      const newer = await seedMediaItem(client, {
        ...base,
        lastUsedAt: day('2026-05-01'),
      });
      const svc = makeMediaItemService(db);

      const r = await svc.findAll(workspaceId, { sort: 'recently_used' });
      expect(r.items.map((i) => i.id)).toEqual([newer, older, never]);

      const legacy = await svc.findAll(workspaceId, { sortBy: 'lastUsedAt' });
      expect(legacy.items.map((i) => i.id)).toEqual([newer, older, never]);
    });
  });

  it('sort and starred win over the legacy sortBy and isStarred', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, uploadedById: ownerId };
      const b = await seedMediaItem(client, {
        ...base,
        name: 'b.png',
        isStarred: true,
      });
      const a = await seedMediaItem(client, {
        ...base,
        name: 'A.png',
        isStarred: true,
      });
      await seedMediaItem(client, { ...base, name: 'c.png', isStarred: false });
      const svc = makeMediaItemService(db);

      const r = await svc.findAll(workspaceId, {
        starred: true,
        isStarred: false,
        sort: 'name',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      expect(r.items.map((i) => i.id)).toEqual([a, b]);
    });
  });

  it('the contract query names validate from query-string values', async () => {
    const q = await toDto(MediaItemQueryDto, {
      type: 'images',
      starred: 'true',
      neverUsed: 'true',
      gifOnly: 'false',
      ratio: '9:16',
      addedSince: '2026-10-01',
      uploadedBy: '7b0f9c8e-8d36-4a52-9a4c-3f3c3b0f1a11',
      sort: 'most_used',
      limit: '20',
    });
    expect(q).toMatchObject({
      type: 'images',
      starred: true,
      neverUsed: true,
      gifOnly: false,
      limit: 20,
    });
    expect(
      await validationErrors(MediaItemQueryDto, { ratio: '3:2' }),
    ).toHaveLength(1);
    expect(
      await validationErrors(MediaItemQueryDto, { sort: 'oldest' }),
    ).toHaveLength(1);
  });
});

describeLibraryDb('library items: uploader and alt text', () => {
  it('rows carry uploadedBy as a UserRef, in the list and alone', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      const svc = makeMediaItemService(db);
      const expected = { id: ownerId, name: 'Owner', avatarUrl: null };

      const list = await svc.findAll(workspaceId);
      expect(list.items[0].uploadedBy).toEqual(expected);
      expect((await svc.findOne(workspaceId, id)).uploadedBy).toEqual(expected);
    });
  });

  it('update sets altText and null clears it; create stores altText and pageCount', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = makeMediaItemService(db);
      const created = await svc.create(
        workspaceId,
        ownerId,
        await toDto(CreateMediaItemDto, {
          type: 'document',
          name: 'deck.pdf',
          fileUrl: 'https://cdn.example.test/deck.pdf',
          altText: 'Pitch deck',
          pageCount: 12,
        }),
      );
      expect(created.altText).toBe('Pitch deck');
      expect(created.pageCount).toBe(12);

      await svc.update(
        workspaceId,
        created.id,
        await toDto(UpdateMediaItemDto, { altText: 'A cat' }),
      );
      expect((await svc.findOne(workspaceId, created.id)).altText).toBe(
        'A cat',
      );

      await svc.update(
        workspaceId,
        created.id,
        await toDto(UpdateMediaItemDto, { altText: null }),
      );
      expect((await svc.findOne(workspaceId, created.id)).altText).toBeNull();

      expect(
        await validationErrors(UpdateMediaItemDto, {
          altText: 'x'.repeat(1001),
        }),
      ).toHaveLength(1);
      expect(
        await validationErrors(CreateMediaItemDto, {
          type: 'document',
          name: 'd',
          fileUrl: 'https://cdn.example.test/d.pdf',
          pageCount: 0,
        }),
      ).toHaveLength(1);
    });
  });
});

describeLibraryDb('library items: select-all bulk', () => {
  it('stars every match of the filter and nothing else', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const images = await seedManyItems(client, workspaceId, ownerId, 120);
      const [video] = await seedManyItems(
        client,
        workspaceId,
        ownerId,
        1,
        'video',
      );
      const svc = makeMediaItemService(db);

      const dto = await toDto(BulkActionDto, {
        action: 'star',
        selectAll: { filter: { type: 'image', starred: false } },
      });
      expect(await svc.bulkAction(workspaceId, ownerId, dto)).toEqual({
        affectedCount: 120,
      });

      const { rows } = await client.query<{ id: string; is_starred: boolean }>(
        'SELECT id, is_starred FROM media_items WHERE workspace_id = $1',
        [workspaceId],
      );
      const starred = new Map(rows.map((r) => [r.id, r.is_starred]));
      expect(images.every((id) => starred.get(id) === true)).toBe(true);
      expect(starred.get(video)).toBe(false);
    });
  });

  it('runs past one chunk and ignores limit and offset', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seedManyItems(client, workspaceId, ownerId, 501);
      const svc = makeMediaItemService(db);

      const dto = await toDto(BulkActionDto, {
        action: 'delete',
        selectAll: { filter: { type: 'image', limit: 5, offset: 3 } },
      });
      expect(await svc.bulkAction(workspaceId, ownerId, dto)).toEqual({
        affectedCount: 501,
      });
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM media_items
         WHERE workspace_id = $1 AND is_deleted AND deleted_by_id = $2`,
        [workspaceId, ownerId],
      );
      expect(rows[0].n).toBe(501);
    });
  });

  it('a select-all never reaches another workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      await seedManyItems(client, workspaceId, ownerId, 2);
      const [foreign] = await seedManyItems(
        client,
        other.workspaceId,
        other.ownerId,
        1,
      );
      const svc = makeMediaItemService(db);

      const dto = await toDto(BulkActionDto, {
        action: 'star',
        selectAll: { filter: {} },
      });
      expect(await svc.bulkAction(workspaceId, ownerId, dto)).toEqual({
        affectedCount: 2,
      });
      const { rows } = await client.query<{ is_starred: boolean }>(
        'SELECT is_starred FROM media_items WHERE id = $1',
        [foreign],
      );
      expect(rows[0].is_starred).toBe(false);
    });
  });

  it('refuses both ids and selectAll, and neither', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const [id] = await seedManyItems(client, workspaceId, ownerId, 1);
      const svc = makeMediaItemService(db);
      const msg = new BadRequestException('Send ids or selectAll, not both');

      const both = await toDto(BulkActionDto, {
        ids: [id],
        selectAll: { filter: {} },
        action: 'star',
      });
      await expect(svc.bulkAction(workspaceId, ownerId, both)).rejects.toThrow(
        msg,
      );
      const neither = await toDto(BulkActionDto, { action: 'star' });
      await expect(
        svc.bulkAction(workspaceId, ownerId, neither),
      ).rejects.toThrow(msg);
    });
  });

  it('caps ids at 500 and validates the select-all filter', async () => {
    const ids = Array.from(
      { length: 501 },
      (_, i) => `7b0f9c8e-8d36-4a52-9a4c-${String(i).padStart(12, '0')}`,
    );
    expect(
      await validationErrors(BulkActionDto, { ids, action: 'star' }),
    ).toHaveLength(1);
    expect(
      await validationErrors(BulkActionDto, {
        action: 'star',
        selectAll: { filter: { ratio: 'wide' } },
      }),
    ).toHaveLength(1);
  });
});

describeLibraryDb('templates and snippets: sort and starred', () => {
  it('templates sort by name, filter starred, and put never-used last', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const b = await seedTemplate(client, {
        ...base,
        name: 'beta',
        isStarred: true,
        lastUsedAt: day('2026-02-01'),
      });
      const a = await seedTemplate(client, {
        ...base,
        name: 'Alpha',
        lastUsedAt: null,
      });
      const c = await seedTemplate(client, {
        ...base,
        name: 'charlie',
        isStarred: true,
        lastUsedAt: day('2026-04-01'),
      });
      const svc = new TemplateService(db);

      const byName = await svc.findAll(workspaceId, { sort: 'name' });
      expect(byName.items.map((t) => t.id)).toEqual([a, b, c]);

      const starred = await svc.findAll(workspaceId, {
        starred: true,
        isStarred: false,
      });
      expect(starred.items.map((t) => t.id).sort()).toEqual([b, c].sort());
      expect(starred.total).toBe(2);

      const recent = await svc.findAll(workspaceId, { sort: 'recently_used' });
      expect(recent.items.map((t) => t.id)).toEqual([c, b, a]);
    });
  });

  it('the template platform filter is applied in SQL, total included', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const ig = await seedTemplate(client, base);
      const fb = await seedTemplate(client, base);
      await client.query(
        `UPDATE media_templates SET platforms = $2::jsonb WHERE id = $1`,
        [ig, JSON.stringify(['instagram', 'threads'])],
      );
      await client.query(
        `UPDATE media_templates SET platforms = $2::jsonb WHERE id = $1`,
        [fb, JSON.stringify(['facebook'])],
      );
      const r = await new TemplateService(db).findAll(workspaceId, {
        platform: 'instagram',
      });
      expect(r.items.map((t) => t.id)).toEqual([ig]);
      expect(r.total).toBe(1);
    });
  });

  it('snippets sort by name, filter starred, and put never-used last', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const b = await seedSnippet(client, {
        ...base,
        name: 'beta',
        isStarred: true,
        lastUsedAt: day('2026-02-01'),
      });
      const a = await seedSnippet(client, {
        ...base,
        name: 'Alpha',
        lastUsedAt: null,
      });
      const c = await seedSnippet(client, {
        ...base,
        name: 'charlie',
        isStarred: true,
        lastUsedAt: day('2026-04-01'),
      });
      const svc = new TextSnippetService(db);

      const byName = await svc.findAll(workspaceId, { sort: 'name' });
      expect(byName.items.map((t) => t.id)).toEqual([a, b, c]);

      const starred = await svc.findAll(workspaceId, {
        starred: true,
        isStarred: false,
      });
      expect(starred.items.map((t) => t.id).sort()).toEqual([b, c].sort());
      expect(starred.total).toBe(2);

      const recent = await svc.findAll(workspaceId, { sort: 'recently_used' });
      expect(recent.items.map((t) => t.id)).toEqual([c, b, a]);
    });
  });
});

interface BulkKindCase {
  kind: string;
  table: string;
  folderType: string;
  dto: new () => object;
  seed: (
    client: PoolClient,
    workspaceId: string,
    userId: string,
    categoryId: string,
  ) => Promise<string>;
  service: (db: DbType) => {
    bulkAction(
      workspaceId: string,
      userId: string,
      dto: never,
    ): Promise<{ affectedCount: number }>;
  };
}

// X1: on every bulk endpoint, move with categoryId null unfiles, and a move
// with no categoryId at all is refused.
const BULK_KINDS: BulkKindCase[] = [
  {
    kind: 'items',
    table: 'media_items',
    folderType: 'media',
    dto: BulkActionDto,
    seed: (client, workspaceId, uploadedById, categoryId) =>
      seedMediaItem(client, { workspaceId, uploadedById, categoryId }),
    service: (db) => makeMediaItemService(db),
  },
  {
    kind: 'templates',
    table: 'media_templates',
    folderType: 'template',
    dto: TemplateBulkDto,
    seed: (client, workspaceId, createdById, categoryId) =>
      seedTemplate(client, { workspaceId, createdById, categoryId }),
    service: (db) => new TemplateService(db),
  },
  {
    kind: 'snippets',
    table: 'text_snippets',
    folderType: 'text_snippet',
    dto: SnippetBulkDto,
    seed: (client, workspaceId, createdById, categoryId) =>
      seedSnippet(client, { workspaceId, createdById, categoryId }),
    service: (db) => new TextSnippetService(db),
  },
  {
    kind: 'links',
    table: 'saved_links',
    folderType: 'link',
    dto: LinkBulkDto,
    seed: (client, workspaceId, createdById, categoryId) =>
      seedLink(client, { workspaceId, createdById, categoryId }),
    service: (db) => new SavedLinkService(db),
  },
];

describeLibraryDb('templates, snippets and links: bulk', () => {
  it('template move files into a template folder and refuses a link folder', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const ids = [
        await seedTemplate(client, base),
        await seedTemplate(client, base),
      ];
      const tplFolder = await seedCategory(client, workspaceId, 'template');
      const linkFolder = await seedCategory(client, workspaceId, 'link');
      const svc = new TemplateService(db);

      const ok = await toDto(TemplateBulkDto, {
        ids,
        action: 'move',
        categoryId: tplFolder,
      });
      expect(await svc.bulkAction(workspaceId, ownerId, ok)).toEqual({
        affectedCount: 2,
      });

      const bad = await toDto(TemplateBulkDto, {
        ids,
        action: 'move',
        categoryId: linkFolder,
      });
      await expect(
        svc.bulkAction(workspaceId, ownerId, bad),
      ).rejects.toBeInstanceOf(BadRequestException);
      const { rows } = await client.query<{ category_id: string }>(
        'SELECT category_id FROM media_templates WHERE id = ANY($1)',
        [ids],
      );
      expect(rows.map((r) => r.category_id)).toEqual([tplFolder, tplFolder]);
    });
  });

  it.each(BULK_KINDS)(
    '$kind: move with categoryId null unfiles; move without it is a 400',
    async ({ table, folderType, dto, seed, service }) => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const folder = await seedCategory(client, workspaceId, folderType);
        const ids = [
          await seed(client, workspaceId, ownerId, folder),
          await seed(client, workspaceId, ownerId, folder),
        ];
        const svc = service(db);

        const unfile = await toDto(dto, {
          ids,
          action: 'move',
          categoryId: null,
        });
        expect(
          await svc.bulkAction(workspaceId, ownerId, unfile as never),
        ).toEqual({ affectedCount: 2 });
        const { rows } = await client.query<{ category_id: string | null }>(
          `SELECT category_id FROM ${table} WHERE id = ANY($1)`,
          [ids],
        );
        expect(rows.map((r) => r.category_id)).toEqual([null, null]);

        const noTarget = await toDto(dto, { ids, action: 'move' });
        await expect(
          svc.bulkAction(workspaceId, ownerId, noTarget as never),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    },
  );

  it('snippet select-all delete soft-deletes only the captions', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER');
      const base = { workspaceId, createdById: ownerId };
      const captions = [
        await seedSnippet(client, { ...base, snippetType: 'caption' }),
        await seedSnippet(client, { ...base, snippetType: 'caption' }),
      ];
      const tags = await seedSnippet(client, {
        ...base,
        snippetType: 'hashtags',
      });
      const svc = new TextSnippetService(db);

      const dto = await toDto(SnippetBulkDto, {
        action: 'delete',
        selectAll: { filter: { type: 'caption' } },
      });
      expect(await svc.bulkAction(workspaceId, memberId, dto)).toEqual({
        affectedCount: 2,
      });

      const { rows } = await client.query<{
        id: string;
        is_deleted: boolean;
        deleted_at: Date | null;
        deleted_by_id: string | null;
      }>(
        `SELECT id, is_deleted, deleted_at, deleted_by_id
         FROM text_snippets WHERE workspace_id = $1`,
        [workspaceId],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of captions) {
        expect(byId.get(id)).toMatchObject({
          is_deleted: true,
          deleted_by_id: memberId,
        });
        expect(byId.get(id)?.deleted_at).not.toBeNull();
      }
      expect(byId.get(tags)).toMatchObject({
        is_deleted: false,
        deleted_by_id: null,
      });
    });
  });

  it('link star by ids counts the rows, and a foreign id is a 400', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const base = { workspaceId, createdById: ownerId };
      const ids = [
        await seedLink(client, base),
        await seedLink(client, base),
        await seedLink(client, base),
      ];
      const foreign = await seedLink(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
      });
      const svc = new SavedLinkService(db);

      const dto = await toDto(LinkBulkDto, { ids, action: 'star' });
      expect(await svc.bulkAction(workspaceId, ownerId, dto)).toEqual({
        affectedCount: 3,
      });
      const { rows } = await client.query<{ is_starred: boolean }>(
        'SELECT is_starred FROM saved_links WHERE id = ANY($1)',
        [ids],
      );
      expect(rows.every((r) => r.is_starred)).toBe(true);

      const mixed = await toDto(LinkBulkDto, {
        ids: [ids[0], foreign],
        action: 'star',
      });
      await expect(svc.bulkAction(workspaceId, ownerId, mixed)).rejects.toThrow(
        new BadRequestException('Some items not found'),
      );
      const f = await client.query<{ is_starred: boolean }>(
        'SELECT is_starred FROM saved_links WHERE id = $1',
        [foreign],
      );
      expect(f.rows[0].is_starred).toBe(false);
    });
  });

  it('the other kinds refuse both ids and selectAll, and neither', async () => {
    await withLibraryDb(async (db) => {
      const id = '7b0f9c8e-8d36-4a52-9a4c-3f3c3b0f1a11';
      const both = { ids: [id], selectAll: { filter: {} }, action: 'star' };
      const msg = new BadRequestException('Send ids or selectAll, not both');
      await expect(
        new TemplateService(db).bulkAction(
          id,
          id,
          await toDto(TemplateBulkDto, both),
        ),
      ).rejects.toThrow(msg);
      await expect(
        new TextSnippetService(db).bulkAction(
          id,
          id,
          await toDto(SnippetBulkDto, { action: 'star' }),
        ),
      ).rejects.toThrow(msg);
      await expect(
        new SavedLinkService(db).bulkAction(
          id,
          id,
          await toDto(LinkBulkDto, both),
        ),
      ).rejects.toThrow(msg);
    });
  });
});
