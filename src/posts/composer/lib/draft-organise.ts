import { BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { campaigns } from '../../../drizzle/schema/campaigns.schema';

/** All this file asks of the database. */
type Reader = Pick<DbType, 'select'>;

/** Most labels one post may carry. */
export const MAX_LABELS = 20;
/** Longest single label, in characters. */
export const MAX_LABEL_LENGTH = 40;
/** Most distinct labels the catalogue returns. */
export const LABEL_CATALOGUE_LIMIT = 200;

/**
 * How a post is filed: the campaign it belongs to and its free-form labels.
 *
 * Both live in `posts.metadata` (no migration). `metadata.campaignId` is the
 * key the Planner already reads for its campaign colour, filter and name, so
 * a composer link shows up there without anything new. A post the campaign
 * engine MATERIALISED from a slot also carries `metadata.campaignSlot`; a
 * composer link carries the id only, so it is a reference to the campaign
 * and never a slot of it.
 *
 * Every field follows "absent keeps, present sets": a caller that does not
 * send `campaignId` (an older client, Duplicate, a version restore) leaves
 * the stored value alone, `null` clears it, a string sets it. The composer
 * rewrites `posts.metadata` wholesale on every save, so without this a save
 * from any path that does not know about these keys would erase them.
 */
export interface OrganiseInput {
  campaignId?: string | null;
  labels?: string[] | null;
}

export interface OrganiseView {
  campaignId: string | null;
  labels: string[];
}

/**
 * Trimmed, inner whitespace collapsed, empties dropped, duplicates removed
 * case-insensitively (the first spelling wins), at most `max`.
 */
export function normaliseLabels(
  input: readonly unknown[],
  max: number = MAX_LABELS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const label = raw.replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

function asMeta(existing: unknown): Record<string, unknown> {
  return existing && typeof existing === 'object'
    ? (existing as Record<string, unknown>)
    : {};
}

/** The filing a stored post carries, in the shape the composer reads. */
export function readOrganise(existing: unknown): OrganiseView {
  const meta = asMeta(existing);
  return {
    campaignId: typeof meta.campaignId === 'string' ? meta.campaignId : null,
    labels: Array.isArray(meta.labels) ? normaliseLabels(meta.labels) : [],
  };
}

/**
 * The campaign id that must be checked against the workspace before it is
 * written, or null when there is nothing new to check. An unchanged link was
 * checked when it was made.
 */
export function campaignToCheck(
  existing: unknown,
  input: OrganiseInput,
): string | null {
  if (typeof input.campaignId !== 'string') return null;
  return input.campaignId === asMeta(existing).campaignId
    ? null
    : input.campaignId;
}

/**
 * The metadata keys to spread into the post's new metadata.
 *
 * `campaignSlot` is carried only while the campaign stays the same: it is
 * what ties a materialised post to its slot, and rewriting the post from the
 * composer must not cut that tie. Moving the post to another campaign (or
 * clearing it) drops the slot, since the slot belongs to the old campaign.
 */
export function organiseMeta(
  existing: unknown,
  input: OrganiseInput,
): Record<string, unknown> {
  const meta = asMeta(existing);
  const out: Record<string, unknown> = {};

  const campaignId =
    input.campaignId === undefined ? meta.campaignId : input.campaignId;
  if (typeof campaignId === 'string' && campaignId) {
    out.campaignId = campaignId;
    if (campaignId === meta.campaignId && meta.campaignSlot !== undefined) {
      out.campaignSlot = meta.campaignSlot;
    }
  }

  const labels =
    input.labels === undefined
      ? Array.isArray(meta.labels)
        ? normaliseLabels(meta.labels)
        : []
      : normaliseLabels(input.labels ?? []);
  if (labels.length > 0) out.labels = labels;

  return out;
}

/** 400 unless the campaign exists inside this workspace. */
export async function assertCampaignInWorkspace(
  db: Reader,
  workspaceId: string,
  campaignId: string,
): Promise<void> {
  const rows = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new BadRequestException('That campaign is not in this workspace');
  }
}

/** Check a new campaign link, then return the keys to write. */
export async function resolveOrganise(
  db: Reader,
  workspaceId: string,
  existing: unknown,
  input: OrganiseInput,
): Promise<Record<string, unknown>> {
  const toCheck = campaignToCheck(existing, input);
  if (toCheck) await assertCampaignInWorkspace(db, workspaceId, toCheck);
  return organiseMeta(existing, input);
}
