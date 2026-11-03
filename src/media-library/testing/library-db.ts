import { readFileSync } from 'fs';
import { join } from 'path';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { MediaItemService } from '../services/media-item.service';
import type { CloudinaryService } from '../../media/cloudinary.service';
import type { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import {
  StorageObjectService,
  cloudinaryThumbFolder,
  cloudinaryUploadFolder,
} from '../services/storage-object.service';
import { StorageQuotaService } from '../services/storage-quota.service';

export {
  seedWorkspace,
  seedMember,
  seedChannel,
} from '../../inbox/testing/inbox-db';

const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
);
const EVERGREEN_TABLES_SQL = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-08-18-evergreen-recycling-tables.sql',
);

/**
 * Migration files every library DB spec replays, in order. Later tasks append
 * their files here.
 */
export const LIBRARY_MIGRATIONS: string[] = [
  '0054_library_columns.sql',
  '0055_posts_library_refs.sql',
  '0056_media_categories_created_by.sql',
];

export const describeLibraryDb = describeDb;

/**
 * Every library DB spec also gets the evergreen tables: the reference test
 * (`itemReferencedSql`, Task 9) reads them, and purge runs it.
 */
export function withLibraryDb<T>(
  fn: (db: DbType, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(LIBRARY_MIGRATIONS, async (db, client) => {
    await ensureEvergreenTables(client);
    return fn(db, client);
  });
}

/**
 * Replays one migration file on the harness connection. Backfill tests seed
 * legacy rows first, then call this.
 */
export async function applyMigrationAgain(
  client: PoolClient,
  file: string,
): Promise<void> {
  await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
}

const rand = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// MediaItemService factory (B9)
// ---------------------------------------------------------------------------

export interface MediaItemServiceDeps {
  storageObjects: StorageObjectService;
  quota: StorageQuotaService;
}

/** The Cloudinary cloud and R2 bucket the provider mocks treat as ours. */
export const TEST_CLOUDINARY_BASE = 'https://res.cloudinary.com/test-cloud';
export const TEST_R2_BASE = 'https://r2.example.test';

/**
 * Cloudinary and R2 mocks that recognise the test cloud and bucket the way the
 * real services recognise ours. Every stored file exists and holds 1 byte
 * unless a spec says otherwise.
 */
export function makeStorageMocks() {
  const cloudinary = {
    delete: jest.fn().mockResolvedValue(true),
    isReady: jest.fn().mockReturnValue(true),
    isOwnUrl: jest.fn((url: string) =>
      url.startsWith(`${TEST_CLOUDINARY_BASE}/`),
    ),
    getResourceBytes: jest.fn().mockResolvedValue({ kind: 'size', bytes: 1 }),
  };
  const r2 = {
    deleteObject: jest.fn().mockResolvedValue(undefined),
    keyFromPublicUrl: jest.fn((url: string) =>
      url.startsWith(`${TEST_R2_BASE}/`)
        ? url.slice(TEST_R2_BASE.length + 1)
        : null,
    ),
    isOwnUrl: jest.fn((url: string) => url.startsWith(`${TEST_R2_BASE}/`)),
    verifyObject: jest
      .fn()
      .mockResolvedValue({ exists: true, contentLength: 1 }),
  };
  return { cloudinary, r2 };
}

/**
 * A Cloudinary file this workspace stored through a signed direct upload, as
 * `POST items` must reference it (SEC5).
 */
export function ownCloudinaryFile(
  workspaceId: string,
  name: string = rand(),
): { fileUrl: string; cloudinaryPublicId: string } {
  const publicId = `${cloudinaryUploadFolder(workspaceId)}/${name}`;
  return {
    fileUrl: `${TEST_CLOUDINARY_BASE}/image/upload/v1/${publicId}.png`,
    cloudinaryPublicId: publicId,
  };
}

/**
 * A video poster this workspace stored through `upload/file` with
 * `purpose: 'thumbnail'`, as `POST items` receives it in `thumbnailUrl`.
 */
export function ownPoster(
  workspaceId: string,
  name: string = rand(),
): { url: string; publicId: string } {
  const publicId = `${cloudinaryThumbFolder(workspaceId)}/${name}`;
  return {
    url: `${TEST_CLOUDINARY_BASE}/image/upload/v1/${publicId}.jpg`,
    publicId,
  };
}

/** An R2 composer video this workspace stored, keyed the way R2 issues it. */
export function ownR2File(workspaceId: string): {
  fileUrl: string;
  cloudinaryPublicId: string;
} {
  const hex = Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  const key = `composer/videos/${workspaceId}/user-1/${Date.now()}-${hex}.mp4`;
  return { fileUrl: `${TEST_R2_BASE}/${key}`, cloudinaryPublicId: key };
}

/**
 * The only way specs construct MediaItemService: provider calls are jest.fn()
 * mocks and the quota service is real (on the harness db) unless overridden,
 * and a constructor change lands here once.
 */
export function makeMediaItemService(
  db: DbType,
  overrides: Partial<MediaItemServiceDeps> = {},
): MediaItemService {
  const { cloudinary, r2 } = makeStorageMocks();
  const cloudinaryService = cloudinary as unknown as CloudinaryService;
  const deps: MediaItemServiceDeps = {
    storageObjects: new StorageObjectService(
      cloudinaryService,
      r2 as unknown as CloudflareR2Service,
      db,
    ),
    quota: new StorageQuotaService(db),
    ...overrides,
  };
  return new MediaItemService(db, deps.storageObjects, deps.quota);
}

// ---------------------------------------------------------------------------
// Fixtures (raw SQL, so they hold across schema changes in later tasks)
// ---------------------------------------------------------------------------

interface SoftDeleteFields {
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedById?: string | null;
}

interface UsageFields {
  categoryId?: string | null;
  isStarred?: boolean;
  lastUsedAt?: Date | null;
  usageCount?: number;
}

export interface SeedMediaItemInput extends SoftDeleteFields, UsageFields {
  workspaceId: string;
  uploadedById: string;
  type?: 'image' | 'video' | 'gif' | 'document';
  name?: string;
  fileUrl?: string;
  thumbnailUrl?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  tags?: string[];
  cloudinaryPublicId?: string | null;
  storageProvider?: 'cloudinary' | 'r2';
  altText?: string | null;
  createdAt?: Date;
}

export async function seedMediaItem(
  client: PoolClient,
  i: SeedMediaItemInput,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_items
       (workspace_id, uploaded_by_id, category_id, type, name, file_url,
        thumbnail_url, mime_type, file_size, width, height, cloudinary_public_id,
        tags, is_starred, usage_count, last_used_at, is_deleted, deleted_at,
        deleted_by_id, created_at, storage_provider, alt_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
             $14, $15, $16, $17, $18, $19, COALESCE($20, now()),
             COALESCE($21, 'cloudinary'), $22)
     RETURNING id`,
    [
      i.workspaceId,
      i.uploadedById,
      i.categoryId ?? null,
      i.type ?? 'image',
      i.name ?? `item-${rand()}.png`,
      i.fileUrl ?? `https://cdn.example.test/${rand()}.png`,
      i.thumbnailUrl ?? null,
      i.mimeType ?? null,
      i.fileSize ?? null,
      i.width ?? null,
      i.height ?? null,
      i.cloudinaryPublicId ?? null,
      JSON.stringify(i.tags ?? []),
      i.isStarred ?? false,
      i.usageCount ?? 0,
      i.lastUsedAt ?? null,
      i.isDeleted ?? false,
      i.deletedAt ?? null,
      i.deletedById ?? null,
      i.createdAt ?? null,
      i.storageProvider ?? null,
      i.altText ?? null,
    ],
  );
  return r.rows[0].id;
}

export interface SeedTemplateInput extends SoftDeleteFields, UsageFields {
  workspaceId: string;
  createdById: string;
  name?: string;
  templateType?: string;
  thumbnailUrl?: string | null;
}

export async function seedTemplate(
  client: PoolClient,
  i: SeedTemplateInput,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_templates
       (workspace_id, created_by_id, category_id, name, template_type, content,
        thumbnail_url, is_starred, usage_count, last_used_at, is_deleted,
        deleted_at, deleted_by_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      i.workspaceId,
      i.createdById,
      i.categoryId ?? null,
      i.name ?? `template-${rand()}`,
      i.templateType ?? 'post',
      JSON.stringify({ text: 'Hello', mediaSlots: [], hashtags: [] }),
      i.thumbnailUrl ?? null,
      i.isStarred ?? false,
      i.usageCount ?? 0,
      i.lastUsedAt ?? null,
      i.isDeleted ?? false,
      i.deletedAt ?? null,
      i.deletedById ?? null,
    ],
  );
  return r.rows[0].id;
}

export interface SeedSnippetInput extends SoftDeleteFields, UsageFields {
  workspaceId: string;
  createdById: string;
  name?: string;
  snippetType?: string;
  content?: string;
}

export async function seedSnippet(
  client: PoolClient,
  i: SeedSnippetInput,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO text_snippets
       (workspace_id, created_by_id, category_id, name, snippet_type, content,
        is_starred, usage_count, last_used_at, is_deleted, deleted_at,
        deleted_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      i.workspaceId,
      i.createdById,
      i.categoryId ?? null,
      i.name ?? `snippet-${rand()}`,
      i.snippetType ?? 'caption',
      i.content ?? 'Snippet text',
      i.isStarred ?? false,
      i.usageCount ?? 0,
      i.lastUsedAt ?? null,
      i.isDeleted ?? false,
      i.deletedAt ?? null,
      i.deletedById ?? null,
    ],
  );
  return r.rows[0].id;
}

export interface SeedLinkInput extends SoftDeleteFields, UsageFields {
  workspaceId: string;
  createdById: string;
  name?: string;
  url?: string;
  previewImageUrl?: string | null;
  previewTitle?: string | null;
}

/** B15: saved links are a Library kind with the same lifecycle columns. */
export async function seedLink(
  client: PoolClient,
  i: SeedLinkInput,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO saved_links
       (workspace_id, created_by_id, category_id, name, url, preview_image_url,
        preview_title, is_starred, usage_count, last_used_at, is_deleted,
        deleted_at, deleted_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      i.workspaceId,
      i.createdById,
      i.categoryId ?? null,
      i.name ?? `link-${rand()}`,
      i.url ?? `https://example.test/${rand()}`,
      i.previewImageUrl ?? null,
      i.previewTitle ?? null,
      i.isStarred ?? false,
      i.usageCount ?? 0,
      i.lastUsedAt ?? null,
      i.isDeleted ?? false,
      i.deletedAt ?? null,
      i.deletedById ?? null,
    ],
  );
  return r.rows[0].id;
}

export async function seedCategory(
  client: PoolClient,
  workspaceId: string,
  type: string,
  name?: string,
  createdAt?: Date,
  createdById?: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_categories (workspace_id, name, type, created_at, created_by_id)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5) RETURNING id`,
    [
      workspaceId,
      name ?? `category-${rand()}`,
      type,
      createdAt ?? null,
      createdById ?? null,
    ],
  );
  return r.rows[0].id;
}

export interface SeedPostInput {
  workspaceId: string;
  createdById: string;
  content?: string | null;
  mediaItems?: unknown[] | null;
  platformContent?: Record<string, unknown> | null;
  targets?: unknown[];
  status?: string;
  scheduledAt?: Date | null;
  publishedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function seedPost(
  client: PoolClient,
  i: SeedPostInput,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts
       (workspace_id, created_by_id, content, media_items, platform_content,
        targets, status, scheduled_at, published_at, metadata)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      i.workspaceId,
      i.createdById,
      i.content === undefined ? 'Post body' : i.content,
      JSON.stringify(i.mediaItems ?? []),
      JSON.stringify(i.platformContent ?? {}),
      JSON.stringify(i.targets ?? []),
      i.status ?? 'draft',
      i.scheduledAt ?? null,
      i.publishedAt ?? null,
      JSON.stringify(i.metadata ?? {}),
    ],
  );
  return r.rows[0].id;
}

/**
 * Inserts `workspace_usage`. The storage columns are written only when given,
 * so this compiles (and runs) before the migration that adds them.
 */
export async function seedUsage(
  client: PoolClient,
  workspaceId: string,
  opts: { storageBytesLimit?: number; extraStoragePurchased?: number } = {},
): Promise<void> {
  const columns = ['workspace_id', 'channels_limit', 'members_limit'];
  const values: unknown[] = [workspaceId, 3, 1];
  if (opts.storageBytesLimit !== undefined) {
    columns.push('storage_bytes_limit');
    values.push(opts.storageBytesLimit);
  }
  if (opts.extraStoragePurchased !== undefined) {
    columns.push('extra_storage_purchased');
    values.push(opts.extraStoragePurchased);
  }
  const params = values.map((_, n) => `$${n + 1}`).join(', ');
  await client.query(
    `INSERT INTO workspace_usage (${columns.join(', ')}) VALUES (${params})`,
    values,
  );
}

/** B7: gives `userId` a subscription on `planCode`, creating the plan if absent. */
export async function seedSubscription(
  client: PoolClient,
  userId: string,
  planCode: string,
  status = 'active',
): Promise<void> {
  await client.query(
    `INSERT INTO plans
       (code, name, base_price_cents, channels_per_workspace,
        members_per_workspace, max_workspaces)
     VALUES ($1, $1, 0, 3, 1, 1)
     ON CONFLICT (code) DO NOTHING`,
    [planCode],
  );
  await client.query(
    `INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, $2, $3)`,
    [userId, planCode, status],
  );
}

async function seedCampaign(
  client: PoolClient,
  workspaceId: string,
  createdById: string,
  type: 'bulk' | 'evergreen',
  name?: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO campaigns (workspace_id, created_by_id, name, type, schedule)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [
      workspaceId,
      createdById,
      name ?? `campaign-${rand()}`,
      type,
      JSON.stringify({ type }),
    ],
  );
  return r.rows[0].id;
}

function contentMedia(media: { id: string; url?: string }[]) {
  return media.map((m) => ({
    id: m.id,
    filename: `${m.id}.png`,
    kind: 'image',
    ...(m.url ? { url: m.url } : {}),
  }));
}

function slotContent(media: { id: string; url?: string }[]) {
  return {
    mode: 'manual',
    postType: 'post',
    caption: 'Caption',
    media: contentMedia(media),
    threadParts: [],
    templateIds: [],
  };
}

export async function seedCampaignSlot(
  client: PoolClient,
  i: {
    workspaceId: string;
    createdById: string;
    campaignName?: string;
    channelId?: string;
    media: { id: string; url?: string }[];
    postId?: string | null;
    scheduledAt?: Date | null;
    slotStatus?: string;
  },
): Promise<{ campaignId: string; slotId: string }> {
  const campaignId = await seedCampaign(
    client,
    i.workspaceId,
    i.createdById,
    'bulk',
    i.campaignName,
  );
  const r = await client.query<{ id: string }>(
    `INSERT INTO campaign_slot_content
       (campaign_id, date, channel_id, time, content, scheduled_at,
        slot_status, post_id)
     VALUES ($1, '2030-01-01', $2, '09:00', $3::jsonb, $4, $5, $6)
     RETURNING id`,
    [
      campaignId,
      i.channelId ?? `channel-${rand()}`,
      JSON.stringify(slotContent(i.media)),
      i.scheduledAt ?? null,
      i.slotStatus ?? 'pending',
      i.postId ?? null,
    ],
  );
  return { campaignId, slotId: r.rows[0].id };
}

/**
 * The evergreen tables are applied to prod by hand
 * (`drizzle/manual/2026-08-18-evergreen-recycling-tables.sql`), so a local
 * database may not have them. Replays that file's idempotent DDL on the
 * harness connection, minus its own BEGIN/COMMIT: a COMMIT would end the
 * harness transaction and leak every fixture. The DDL rolls back with it.
 */
async function ensureEvergreenTables(client: PoolClient): Promise<void> {
  const sql = readFileSync(EVERGREEN_TABLES_SQL, 'utf8').replace(
    /^(BEGIN|COMMIT);\s*$/gm,
    '',
  );
  await client.query(sql);
}

export async function seedEvergreenPost(
  client: PoolClient,
  i: {
    workspaceId: string;
    createdById: string;
    media: { id: string; url?: string }[];
    variationMedia?: { id: string; url?: string }[];
  },
): Promise<{ campaignId: string; postId: string }> {
  await ensureEvergreenTables(client);
  const campaignId = await seedCampaign(
    client,
    i.workspaceId,
    i.createdById,
    'evergreen',
  );
  const cat = await client.query<{ id: string }>(
    `INSERT INTO campaign_evergreen_categories
       (campaign_id, name, color, schedule)
     VALUES ($1, 'Pool', '#000000', $2::jsonb) RETURNING id`,
    [campaignId, JSON.stringify({ weekdays: [1], times: ['09:00'] })],
  );
  const variations = i.variationMedia
    ? [
        {
          id: `var-${rand()}`,
          caption: 'Variation',
          media: contentMedia(i.variationMedia),
          source: 'manual',
        },
      ]
    : [];
  const post = await client.query<{ id: string }>(
    `INSERT INTO campaign_evergreen_posts
       (campaign_id, category_id, content, variations, recycle_policy)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) RETURNING id`,
    [
      campaignId,
      cat.rows[0].id,
      JSON.stringify(slotContent(i.media)),
      JSON.stringify(variations),
      JSON.stringify({ mode: 'forever' }),
    ],
  );
  return { campaignId, postId: post.rows[0].id };
}
