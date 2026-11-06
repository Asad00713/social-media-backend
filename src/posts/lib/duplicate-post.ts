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
] as const;

/**
 * The insert row for "Copy to a new draft": the caption, media and per-channel
 * content survive; everything about scheduling, publishing, failure, readiness
 * and campaign membership does not.
 */
export function buildDuplicate(
  source: PostRow,
  userId: string,
): typeof posts.$inferInsert {
  const metadata: Record<string, unknown> = {
    ...((source.metadata ?? {}) as Record<string, unknown>),
  };
  for (const key of STRIPPED_METADATA) delete metadata[key];
  if (metadata.source === 'first_week') metadata.source = 'composer';
  // A copy of a draft that needs approval needs its own: the request is kept
  // (now in the copier's name), the grant is not — or copying would be a way
  // round the approval.
  delete metadata.approval;
  if (readApproval(source.metadata)) {
    metadata.approval = newApprovalRequest(userId);
  }

  const targets = (source.targets ?? []).map((t) => ({
    channelId: t.channelId,
    platform: t.platform,
    status: 'draft' as const,
    publishStatus: 'queued',
    retryCount: 0,
    ...(t.destination ? { destination: structuredClone(t.destination) } : {}),
    ...(t.contentOverride
      ? { contentOverride: structuredClone(t.contentOverride) }
      : {}),
  }));

  return {
    workspaceId: source.workspaceId,
    createdById: userId,
    content: source.content,
    mediaItems: structuredClone(source.mediaItems ?? []),
    platformContent: structuredClone(source.platformContent ?? {}),
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
