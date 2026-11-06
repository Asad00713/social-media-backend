import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaCategories,
  mediaItems,
  mediaTemplates,
  savedLinks,
  textSnippets,
  type TemplateMedia,
} from '../../drizzle/schema/media-library.schema';
import type { FolderKind } from '../lib/folder-kind';
import {
  SAMPLE_FOLDER_NAME,
  SAMPLE_IMAGES,
  SAMPLE_LINK,
  SAMPLE_SNIPPETS,
  SAMPLE_TEMPLATES,
} from './sample-content';
import { sampleAssetBaseUrl, sampleAssetUrl } from './sample-assets';

export type SampleSeedResult =
  | {
      status: 'seeded';
      media: number;
      templates: number;
      snippets: number;
      links: number;
      folders: number;
    }
  | { status: 'skipped'; reason: 'already_seeded' | 'no_workspace' };

/**
 * Seeds a new workspace's Library with sample content: a "Getting started"
 * folder per tab, sample images (shared bundled files, never copied), four
 * templates, three snippets and one link. Every row has `is_sample = true`
 * and no creator.
 *
 * Idempotent: one transaction under a per-workspace advisory lock, and a
 * workspace that already has any sample row is skipped, so a second call (a
 * retry, a double submit) adds nothing. All or nothing: a failure rolls the
 * whole seed back. No network call: the images are our own files and the
 * link's preview is written, not fetched.
 */
@Injectable()
export class LibrarySamplesService {
  private readonly logger = new Logger(LibrarySamplesService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Seeds after the response, off the request path. Never throws and never
   * rejects: a seeding failure is logged and the workspace stays as created.
   *
   * Fire-and-forget rather than a BullMQ job: the seed is one short
   * transaction of a few inserts, idempotent and non-essential, so a queue
   * (Redis, a processor, retries) would add moving parts for nothing the
   * owner asked to keep. The trade-off is accepted: if the process dies in the
   * moment between the response and the seed, that workspace has no samples
   * (there is no backfill by design).
   */
  seedInBackground(workspaceId: string): void {
    setImmediate(() => {
      this.seed(workspaceId).then(
        (result) =>
          this.logger.log(
            `Library samples for workspace ${workspaceId}: ${JSON.stringify(result)}`,
          ),
        (error: unknown) =>
          this.logger.error(
            `Library samples failed for workspace ${workspaceId} (the workspace is fine): ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      );
    });
  }

  async seed(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SampleSeedResult> {
    const base = sampleAssetBaseUrl(env);
    if (!base) {
      this.logger.warn(
        `No API_PUBLIC_URL / APP_URL: workspace ${workspaceId} gets no sample images`,
      );
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'library-samples:' + workspaceId}, 0))`,
      );

      const state = await tx.execute<{
        has_workspace: boolean;
        has_samples: boolean;
      }>(sql`
        SELECT
          EXISTS (SELECT 1 FROM workspace WHERE id = ${workspaceId}::uuid) AS has_workspace,
          (EXISTS (SELECT 1 FROM media_categories WHERE workspace_id = ${workspaceId}::uuid AND is_sample)
           OR EXISTS (SELECT 1 FROM media_items WHERE workspace_id = ${workspaceId}::uuid AND is_sample)
           OR EXISTS (SELECT 1 FROM media_templates WHERE workspace_id = ${workspaceId}::uuid AND is_sample)
           OR EXISTS (SELECT 1 FROM text_snippets WHERE workspace_id = ${workspaceId}::uuid AND is_sample)
           OR EXISTS (SELECT 1 FROM saved_links WHERE workspace_id = ${workspaceId}::uuid AND is_sample)
          ) AS has_samples
      `);
      const { has_workspace, has_samples } = state.rows[0];
      if (!has_workspace) return { status: 'skipped', reason: 'no_workspace' };
      if (has_samples) return { status: 'skipped', reason: 'already_seeded' };

      const kinds: FolderKind[] = base
        ? ['media', 'template', 'text_snippet', 'link']
        : ['template', 'text_snippet', 'link'];
      const folderOf = await this.insertFolders(
        tx as unknown as DbType,
        workspaceId,
        kinds,
      );

      // Media first: templates attach the same rows by libraryItemId.
      const mediaIdOf = new Map<string, string>();
      if (base) {
        const created = await tx
          .insert(mediaItems)
          .values(
            SAMPLE_IMAGES.map((img) => {
              const url = sampleAssetUrl(base, img.file);
              return {
                workspaceId,
                uploadedById: null,
                isSample: true,
                categoryId: folderOf.get('media'),
                type: 'image' as const,
                name: img.name,
                fileUrl: url,
                thumbnailUrl: url,
                mimeType: 'image/png',
                fileSize: img.bytes,
                width: img.width,
                height: img.height,
                altText: img.altText,
                tags: [],
              };
            }),
          )
          .returning({ id: mediaItems.id, fileUrl: mediaItems.fileUrl });
        for (const row of created) mediaIdOf.set(row.fileUrl, row.id);
      }

      await tx.insert(mediaTemplates).values(
        SAMPLE_TEMPLATES.map((t) => {
          const img = SAMPLE_IMAGES.find((i) => i.file === t.imageFile);
          const url = base && img ? sampleAssetUrl(base, img.file) : null;
          const media: TemplateMedia[] =
            url && img
              ? [
                  {
                    id: `sample-${img.file.replace(/\.png$/, '')}`,
                    type: 'image',
                    url,
                    thumbnailUrl: url,
                    width: img.width,
                    height: img.height,
                    sizeBytes: img.bytes,
                    libraryItemId: mediaIdOf.get(url),
                  },
                ]
              : [];
          return {
            workspaceId,
            createdById: null,
            isSample: true,
            categoryId: folderOf.get('template'),
            name: t.name,
            description: t.description,
            templateType: t.templateType,
            platforms: [],
            content: {
              text: t.text,
              mediaSlots: [],
              media,
              hashtags: t.hashtags,
            },
            thumbnailUrl: url,
            tags: [],
          };
        }),
      );

      await tx.insert(textSnippets).values(
        SAMPLE_SNIPPETS.map((s) => ({
          workspaceId,
          createdById: null,
          isSample: true,
          categoryId: folderOf.get('text_snippet'),
          name: s.name,
          snippetType: s.snippetType,
          content: s.content,
          tags: [],
        })),
      );

      await tx.insert(savedLinks).values({
        workspaceId,
        createdById: null,
        isSample: true,
        categoryId: folderOf.get('link'),
        name: SAMPLE_LINK.name,
        url: SAMPLE_LINK.url,
        description: SAMPLE_LINK.description,
        previewTitle: SAMPLE_LINK.previewTitle,
        previewSiteName: SAMPLE_LINK.previewSiteName,
        utm: SAMPLE_LINK.utm,
        tags: [],
      });

      return {
        status: 'seeded',
        media: mediaIdOf.size,
        templates: SAMPLE_TEMPLATES.length,
        snippets: SAMPLE_SNIPPETS.length,
        links: 1,
        folders: folderOf.size,
      };
    });
  }

  /** One "Getting started" folder per kind, after any folder already there. */
  private async insertFolders(
    tx: DbType,
    workspaceId: string,
    kinds: FolderKind[],
  ): Promise<Map<FolderKind, string>> {
    const orders = await tx.execute<{ type: string; next: number }>(sql`
      SELECT type, (max(display_order) + 1)::int AS next
        FROM media_categories
       WHERE workspace_id = ${workspaceId}::uuid
       GROUP BY type
    `);
    const nextOf = new Map(orders.rows.map((r) => [r.type, Number(r.next)]));
    const rows = await tx
      .insert(mediaCategories)
      .values(
        kinds.map((type) => ({
          workspaceId,
          name: SAMPLE_FOLDER_NAME,
          type,
          displayOrder: nextOf.get(type) ?? 0,
          createdById: null,
          isSample: true,
        })),
      )
      .returning({ id: mediaCategories.id, type: mediaCategories.type });
    return new Map(rows.map((r) => [r.type, r.id]));
  }
}
