import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  ADJUST_KEYS,
  workspaceBrandKits,
  type AdjustPreset,
} from '../drizzle/schema/brand-kits.schema';
import { mediaItems } from '../drizzle/schema/media-library.schema';
import type { CallerRole } from '../posts/guest-rules';
import { roleCan } from '../workspace-members/role-capabilities';
import type {
  BrandKitDto,
  BrandKitLogoDto,
  UpdateBrandKitDto,
} from './dto/brand-kit.dto';

/** Who may change the kit (ADMIN and OWNER). */
export const BRAND_KIT_EDIT_CAPABILITY = 'brand:manage' as const;

/**
 * True when Postgres says the table does not exist (42P01): the code is
 * deployed but 0059 is not applied yet. drizzle wraps driver errors, so the
 * code may sit on `cause`.
 */
export function isMissingTable(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === '42P01') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const canEdit = (role: CallerRole): boolean =>
  role === 'SUPER_ADMIN' ||
  (role !== undefined && roleCan(role, BRAND_KIT_EDIT_CAPABILITY));

/** '#RRGGBB' in, '#rrggbb' out, duplicates dropped, order kept. */
export function normaliseColors(colors: readonly string[]): string[] {
  return [...new Set(colors.map((c) => c.toLowerCase()))];
}

/** Only the seven known sliders, as integers; unknown keys never stored. */
export function normalisePresets(
  presets: ReadonlyArray<{
    id: string;
    name: string;
    values: Record<string, unknown>;
  }>,
): AdjustPreset[] {
  const seen = new Set<string>();
  const out: AdjustPreset[] = [];
  for (const p of presets) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const values: AdjustPreset['values'] = {};
    for (const key of ADJUST_KEYS) {
      const v = p.values?.[key];
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
        values[key] = Math.round(v);
      }
    }
    out.push({ id: p.id, name: p.name.trim(), values });
  }
  return out;
}

const EMPTY = (role: CallerRole): BrandKitDto => ({
  colors: [],
  logo: null,
  adjustPresets: [],
  canEdit: canEdit(role),
});

/**
 * The workspace brand kit: the photo editor's brand colours, default
 * watermark logo and team presets. Reads degrade to the empty kit until 0059
 * is applied; writes answer 503.
 */
@Injectable()
export class BrandKitService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async get(workspaceId: string, role: CallerRole): Promise<BrandKitDto> {
    let row: typeof workspaceBrandKits.$inferSelect | undefined;
    try {
      [row] = await this.db
        .select()
        .from(workspaceBrandKits)
        .where(eq(workspaceBrandKits.workspaceId, workspaceId));
    } catch (err) {
      if (isMissingTable(err)) return EMPTY(role);
      throw err;
    }
    if (!row) return EMPTY(role);
    return {
      colors: Array.isArray(row.colors) ? row.colors : [],
      logo: row.logoMediaId
        ? await this.logo(workspaceId, row.logoMediaId)
        : null,
      adjustPresets: Array.isArray(row.adjustPresets) ? row.adjustPresets : [],
      canEdit: canEdit(role),
    };
  }

  /** Changes only the fields sent; the route already required an editor. */
  async update(
    workspaceId: string,
    userId: string,
    role: CallerRole,
    dto: UpdateBrandKitDto,
  ): Promise<BrandKitDto> {
    const patch: Partial<typeof workspaceBrandKits.$inferInsert> = {};
    if (dto.colors !== undefined) patch.colors = normaliseColors(dto.colors);
    if (dto.adjustPresets !== undefined) {
      patch.adjustPresets = normalisePresets(
        dto.adjustPresets as unknown as Parameters<typeof normalisePresets>[0],
      );
    }
    if (dto.logoMediaId !== undefined) {
      if (dto.logoMediaId !== null) {
        await this.assertLogoItem(workspaceId, dto.logoMediaId);
      }
      patch.logoMediaId = dto.logoMediaId;
    }

    try {
      await this.db
        .insert(workspaceBrandKits)
        .values({ workspaceId, updatedById: userId, ...patch })
        .onConflictDoUpdate({
          target: workspaceBrandKits.workspaceId,
          set: { ...patch, updatedById: userId, updatedAt: new Date() },
        });
    } catch (err) {
      if (isMissingTable(err)) {
        throw new ServiceUnavailableException(
          'The brand kit is not available yet. Try again shortly.',
        );
      }
      throw err;
    }
    return this.get(workspaceId, role);
  }

  /** The logo must be a live image in this workspace's Library. */
  private async assertLogoItem(
    workspaceId: string,
    mediaId: string,
  ): Promise<void> {
    const [item] = await this.db
      .select({ type: mediaItems.type, isDeleted: mediaItems.isDeleted })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.id, mediaId),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      );
    if (!item || item.isDeleted) {
      throw new BadRequestException(
        'That logo is not in this workspace Library',
      );
    }
    if (item.type !== 'image') {
      throw new BadRequestException('A logo has to be an image');
    }
  }

  /** A binned Library item reads as no logo. */
  private async logo(
    workspaceId: string,
    mediaId: string,
  ): Promise<BrandKitLogoDto | null> {
    const [item] = await this.db
      .select({
        id: mediaItems.id,
        url: mediaItems.fileUrl,
        name: mediaItems.name,
        width: mediaItems.width,
        height: mediaItems.height,
        isDeleted: mediaItems.isDeleted,
      })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.id, mediaId),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      );
    if (!item || item.isDeleted) return null;
    return {
      mediaId: item.id,
      url: item.url,
      name: item.name,
      width: item.width ?? null,
      height: item.height ?? null,
    };
  }
}
