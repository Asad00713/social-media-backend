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
} from '../testing/library-db';
import {
  CreateSavedLinkDto,
  CreateTemplateDto,
  CreateTextSnippetDto,
  SavedLinkQueryDto,
  TemplateQueryDto,
  TextSnippetQueryDto,
} from '../dto/media-library.dto';
import type { UserRef } from '../dto/contract';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';

const CREATOR_AVATAR = 'https://cdn.example.test/creator.png';

/** The calls every kind shares, so one table drives all three. */
interface KindService {
  findAll(
    ws: string,
    q: {
      createdBy?: string;
      isDeleted?: boolean;
      limit?: number;
      offset?: number;
    },
  ): Promise<{
    items: { id: string; createdBy: UserRef | null }[];
    total: number;
  }>;
  findOne(ws: string, id: string): Promise<{ createdBy: UserRef | null }>;
  softDelete(
    ws: string,
    id: string,
    userId: string,
  ): Promise<{ createdBy: UserRef | null; isDeleted: boolean | null }>;
  restore(ws: string, id: string): Promise<{ createdBy: UserRef | null }>;
}

interface KindCase {
  kind: string;
  service: (db: DbType) => KindService;
  seed: (
    client: PoolClient,
    workspaceId: string,
    createdById: string,
    extra?: { isDeleted?: boolean; deletedAt?: Date; deletedById?: string },
  ) => Promise<string>;
  /** A create through the service, as `userId`. */
  create: (
    db: DbType,
    workspaceId: string,
    userId: string,
  ) => Promise<{ createdBy: UserRef | null }>;
  /** A rename through the service; `update` takes no user. */
  rename: (
    db: DbType,
    workspaceId: string,
    id: string,
  ) => Promise<{ createdBy: UserRef | null }>;
  /** The "record a use" route. */
  use: (
    db: DbType,
    workspaceId: string,
    id: string,
  ) => Promise<{ createdBy: UserRef | null }>;
  queryDto: new () => object;
}

const KINDS: KindCase[] = [
  {
    kind: 'templates',
    service: (db) => new TemplateService(db),
    seed: (client, workspaceId, createdById, extra) =>
      seedTemplate(client, { workspaceId, createdById, ...extra }),
    create: (db, ws, userId) =>
      new TemplateService(db).create(
        ws,
        userId,
        plainToInstance(CreateTemplateDto, {
          name: 'Launch post',
          templateType: 'post',
          content: { text: 'Hello' },
        }),
      ),
    rename: (db, ws, id) =>
      new TemplateService(db).update(ws, id, { name: 'Renamed' }),
    use: (db, ws, id) => new TemplateService(db).incrementUsage(ws, id),
    queryDto: TemplateQueryDto,
  },
  {
    kind: 'snippets',
    service: (db) => new TextSnippetService(db),
    seed: (client, workspaceId, createdById, extra) =>
      seedSnippet(client, { workspaceId, createdById, ...extra }),
    create: (db, ws, userId) =>
      new TextSnippetService(db).create(
        ws,
        userId,
        plainToInstance(CreateTextSnippetDto, {
          name: 'Sign-off',
          snippetType: 'signature',
          content: 'Thanks!',
        }),
      ),
    rename: (db, ws, id) =>
      // A content change takes the recount path too.
      new TextSnippetService(db).update(ws, id, {
        name: 'Renamed',
        content: 'New text',
      }),
    use: (db, ws, id) => new TextSnippetService(db).markUsed(ws, id),
    queryDto: TextSnippetQueryDto,
  },
  {
    kind: 'links',
    service: (db) => new SavedLinkService(db),
    seed: (client, workspaceId, createdById, extra) =>
      seedLink(client, { workspaceId, createdById, ...extra }),
    create: (db, ws, userId) =>
      new SavedLinkService(db).create(
        ws,
        userId,
        plainToInstance(CreateSavedLinkDto, {
          name: 'Docs',
          url: 'https://example.test/docs',
        }),
      ),
    rename: (db, ws, id) =>
      // A URL change takes the recount path too.
      new SavedLinkService(db).update(ws, id, {
        name: 'Renamed',
        url: 'https://example.test/moved',
      }),
    use: (db, ws, id) => new SavedLinkService(db).markUsed(ws, id),
    queryDto: SavedLinkQueryDto,
  },
];

/** A workspace whose owner is not the member who makes the rows. */
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
  const owner: UserRef = { id: ownerId, name: 'Owner', avatarUrl: null };
  return { workspaceId, ownerId, creatorId, creator, owner };
}

describe('createdBy list filter: validation', () => {
  it.each(KINDS.map((k) => [k.kind, k.queryDto] as const))(
    '%s accepts a uuid and refuses anything else',
    async (_kind, dto) => {
      const errors = async (raw: Record<string, unknown>) =>
        validate(plainToInstance(dto, raw), {
          whitelist: true,
          forbidNonWhitelisted: true,
        });
      expect(
        await errors({ createdBy: '7b0f9c8e-8d36-4a52-9a4c-3f3c3b0f1a11' }),
      ).toEqual([]);
      expect(await errors({ createdBy: 'me' })).toHaveLength(1);
    },
  );
});

describeLibraryDb('library: createdBy on templates, snippets and links', () => {
  beforeEach(() => {
    // Link create/update fetch a preview; no network in specs.
    jest
      .spyOn(SavedLinkService.prototype as any, 'fetchLinkPreview')
      .mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each(KINDS)('$kind', (k) => {
    it('list rows and the detail carry the creator as a UserRef', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, creatorId, creator } = await seedTeam(client);
        const id = await k.seed(client, workspaceId, creatorId);
        const svc = k.service(db);

        const list = await svc.findAll(workspaceId, {});
        expect(list.items.map((r) => [r.id, r.createdBy])).toEqual([
          [id, creator],
        ]);
        expect((await svc.findOne(workspaceId, id)).createdBy).toEqual(creator);
      });
    });

    it('the Bin listing of the kind carries the creator, not the deleter', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId, creatorId, creator } =
          await seedTeam(client);
        const id = await k.seed(client, workspaceId, creatorId, {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: ownerId,
        });
        const svc = k.service(db);

        const bin = await svc.findAll(workspaceId, { isDeleted: true });
        expect(bin.items.map((r) => [r.id, r.createdBy])).toEqual([
          [id, creator],
        ]);
        expect((await svc.findOne(workspaceId, id)).createdBy).toEqual(creator);
      });
    });

    it('createdBy filters the list and its total', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId, creatorId } = await seedTeam(client);
        const mine = await k.seed(client, workspaceId, ownerId);
        const theirs = await k.seed(client, workspaceId, creatorId);
        const svc = k.service(db);

        const byOwner = await svc.findAll(workspaceId, { createdBy: ownerId });
        expect(byOwner.items.map((r) => r.id)).toEqual([mine]);
        expect(byOwner.total).toBe(1);

        const byCreator = await svc.findAll(workspaceId, {
          createdBy: creatorId,
        });
        expect(byCreator.items.map((r) => r.id)).toEqual([theirs]);
        expect(byCreator.total).toBe(1);

        const all = await svc.findAll(workspaceId, {});
        expect(all.total).toBe(2);
      });
    });

    it('the join keeps one row per item across pages', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId, creatorId } = await seedTeam(client);
        const ids = [
          await k.seed(client, workspaceId, ownerId),
          await k.seed(client, workspaceId, creatorId),
          await k.seed(client, workspaceId, ownerId),
        ];
        const svc = k.service(db);

        const first = await svc.findAll(workspaceId, { limit: 2, offset: 0 });
        const second = await svc.findAll(workspaceId, { limit: 2, offset: 2 });
        const seen = [...first.items, ...second.items].map((r) => r.id);

        expect(first.total).toBe(3);
        expect(seen).toHaveLength(3);
        expect([...seen].sort()).toEqual([...ids].sort());
      });
    });

    it('every single-item write answers with the creator', async () => {
      await withLibraryDb(async (db, client) => {
        const { workspaceId, ownerId, creatorId, creator, owner } =
          await seedTeam(client);
        const svc = k.service(db);

        // Created through the service: the caller is the creator.
        expect((await k.create(db, workspaceId, ownerId)).createdBy).toEqual(
          owner,
        );

        // Changed by someone else: the creator stays who made it.
        const id = await k.seed(client, workspaceId, creatorId);
        expect((await k.rename(db, workspaceId, id)).createdBy).toEqual(
          creator,
        );
        expect((await k.use(db, workspaceId, id)).createdBy).toEqual(creator);

        const binned = await svc.softDelete(workspaceId, id, ownerId);
        expect(binned.isDeleted).toBe(true);
        expect(binned.createdBy).toEqual(creator);
        expect((await svc.restore(workspaceId, id)).createdBy).toEqual(creator);
      });
    });
  });

  it('a template clone is created by whoever cloned it', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, creatorId, owner } = await seedTeam(client);
      const id = await seedTemplate(client, {
        workspaceId,
        createdById: creatorId,
      });

      const copy = await new TemplateService(db).clone(
        workspaceId,
        ownerId,
        id,
      );

      expect(copy.id).not.toBe(id);
      expect(copy.createdBy).toEqual(owner);
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
      const id = await seedSnippet(client, {
        workspaceId,
        createdById: noName,
      });

      const view = await new TextSnippetService(db).findOne(workspaceId, id);

      expect(view.createdBy).toEqual({
        id: noName,
        name: 'sam.lee',
        avatarUrl: null,
      });
    });
  });
});

describeLibraryDb('library: media uploadedBy in the Bin', () => {
  it('a binned item keeps uploadedBy in the Bin list and the detail', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId, creatorId, creator } =
        await seedTeam(client);
      const id = await seedMediaItem(client, {
        workspaceId,
        uploadedById: creatorId,
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: ownerId,
      });
      const svc = makeMediaItemService(db);

      const bin = await svc.findAll(workspaceId, { isDeleted: true });
      expect(bin.items.map((r) => [r.id, r.uploadedBy])).toEqual([
        [id, creator],
      ]);
      expect((await svc.findOne(workspaceId, id)).uploadedBy).toEqual(creator);
    });
  });
});
