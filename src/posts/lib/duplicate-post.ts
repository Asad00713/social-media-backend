import { BadRequestException } from '@nestjs/common';
import type { posts } from '../../drizzle/schema/posts.schema';
import type { PostRow } from './present-post';
import { newApprovalRequest, readApproval } from './draft-approval';

/** Metadata keys that tie a post to a campaign or a schedule. */
const STRIPPED_METADATA = [
  'campaignId',
  'schedule',
  'firstWeekSlot',
  'suggestedAt',
  'imageCredit',
  // Import markers: a copy of an imported post is a new composed post.
  'syncedFrom',
  'syncedAt',
] as const;

export interface DuplicateOptions {
  /** Keep only the target on this channel (400 when the post has none). */
  channelId?: number;
  /** Copy no targets at all. */
  noTargets?: boolean;
}

/** Drop `mediaItems` from a content block, keeping its other fields. */
function withoutMedia<T extends { mediaItems?: unknown }>(block: T): T {
  const rest = { ...block };
  delete rest.mediaItems;
  return rest;
}

/**
 * The insert row for "Copy to a new draft": the caption, media and per-channel
 * content survive; everything about scheduling, publishing, failure, readiness
 * and campaign membership does not.
 *
 * An imported post (`metadata.syncedFrom === 'platform'`) stores one expiring
 * CDN thumbnail typed `image`, even for a video; re-publishing it would send a
 * wrong or broken image, so imported media is never copied (caption is).
 */
export function buildDuplicate(
  source: PostRow,
  userId: string,
  opts: DuplicateOptions = {},
): typeof posts.$inferInsert {
  if (opts.noTargets && opts.channelId !== undefined) {
    throw new BadRequestException(
      'Use either channelId or noTargets, not both',
    );
  }
  const metadata: Record<string, unknown> = {
    ...((source.metadata ?? {}) as Record<string, unknown>),
  };
  const isImported = metadata.syncedFrom === 'platform';
  for (const key of STRIPPED_METADATA) delete metadata[key];
  if (metadata.source === 'first_week') metadata.source = 'composer';
  // A copy of a draft that needs approval needs its own: the request is kept
  // (now in the copier's name), the grant is not — or copying would be a way
  // round the approval.
  delete metadata.approval;
  if (readApproval(source.metadata)) {
    metadata.approval = newApprovalRequest(userId);
  }

  let sourceTargets = source.targets ?? [];
  if (opts.noTargets) {
    sourceTargets = [];
  } else if (opts.channelId !== undefined) {
    // Stored channel ids are strings; the API takes the numeric id.
    sourceTargets = sourceTargets.filter(
      (t) => String(t.channelId) === String(opts.channelId),
    );
    if (sourceTargets.length === 0) {
      throw new BadRequestException('That channel is not on this post');
    }
  }

  const targets = sourceTargets.map((t) => ({
    channelId: t.channelId,
    platform: t.platform,
    status: 'draft' as const,
    publishStatus: 'queued',
    retryCount: 0,
    ...(t.destination ? { destination: structuredClone(t.destination) } : {}),
    ...(t.contentOverride
      ? {
          contentOverride: isImported
            ? withoutMedia(structuredClone(t.contentOverride))
            : structuredClone(t.contentOverride),
        }
      : {}),
  }));

  return {
    workspaceId: source.workspaceId,
    createdById: userId,
    content: source.content,
    mediaItems: isImported ? [] : structuredClone(source.mediaItems ?? []),
    platformContent: isImported
      ? Object.fromEntries(
          Object.entries(structuredClone(source.platformContent ?? {})).map(
            ([platform, block]) => [platform, withoutMedia(block)],
          ),
        )
      : structuredClone(source.platformContent ?? {}),
    targets: targets as typeof posts.$inferInsert.targets,
    metadata,
    status: 'draft',
    scheduledAt: null,
    publishedAt: null,
    jobId: null,
    lastError: null,
    retryCount: '0',
    readyAt: null,
    readyById: null,
  };
}
