import type { posts } from '../../drizzle/schema/posts.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PublishErrorCode } from '../composer/types/draft.types';
import type {
  PlannerPostDto,
  PlannerPostTargetDto,
  PlannerUserRef,
} from '../dto/planner-post.dto';
import { zonedClock } from '../../planner/lib/workspace-time';
import { describeFailure } from './post-failure';
import { derivePostStatus, targetStatusOf } from './post-status';

export type PostRow = typeof posts.$inferSelect;

/** Stored targets mix the legacy and composer shapes; read both. */
interface StoredTarget {
  channelId: string;
  platform: SupportedPlatform;
  status?: string;
  publishStatus?: string;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedAt?: string;
  errorMessage?: string;
  errorCode?: PublishErrorCode;
  destination?: { id: string; name?: string };
  contentOverride?: PlannerPostTargetDto['contentOverride'];
}

function presentTarget(
  target: StoredTarget,
  post: PostRow,
): PlannerPostTargetDto {
  const status = targetStatusOf(target, post.status);
  // Explicit fields only: stored targets also carry internals (publishStatus,
  // retryCount, attemptedAt) that are not part of the API contract.
  const optional: Partial<PlannerPostTargetDto> = {
    platformPostId: target.platformPostId,
    platformPostUrl: target.platformPostUrl,
    publishedAt: target.publishedAt,
    errorMessage: target.errorMessage,
    errorCode: target.errorCode,
    destination: target.destination,
    contentOverride: target.contentOverride,
  };
  for (const key of Object.keys(optional) as (keyof typeof optional)[]) {
    if (optional[key] === undefined) delete optional[key];
  }
  return {
    ...optional,
    channelId: String(target.channelId),
    platform: target.platform,
    status,
    failure:
      status === 'failed'
        ? describeFailure({
            platform: target.platform,
            errorCode: target.errorCode,
            errorMessage: target.errorMessage ?? post.lastError,
          })
        : null,
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function presentPost(
  row: PostRow,
  ctx: { users: Map<string, PlannerUserRef> },
): PlannerPostDto {
  const stored = (row.targets ?? []) as unknown as StoredTarget[];
  const metadata = (row.metadata ?? {}) as PlannerPostDto['metadata'];
  const readyBy = row.readyById ? ctx.users.get(row.readyById) : undefined;
  const campaignId = metadata.campaignId;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdById: row.createdById,
    content: row.content,
    mediaItems: row.mediaItems ?? [],
    targets: stored.map((t) => presentTarget(t, row)),
    status: row.status,
    displayStatus: derivePostStatus(row.status, stored),
    scheduledAt: iso(row.scheduledAt),
    publishedAt: iso(row.publishedAt),
    occurredAt: iso(row.publishedAt ?? row.scheduledAt),
    platformContent: (row.platformContent ??
      {}) as PlannerPostDto['platformContent'],
    metadata,
    campaignId: typeof campaignId === 'string' ? campaignId : null,
    lastError: row.lastError,
    retryCount: row.retryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    author: ctx.users.get(row.createdById) ?? {
      id: row.createdById,
      name: 'Unknown',
      avatarUrl: null,
    },
    readyAt: iso(row.readyAt),
    readyBy: readyBy ? { id: readyBy.id, name: readyBy.name } : null,
  };
}

/** Groups posts by the workspace-local date of `occurredAt`. */
export function bucketByDate(
  list: PlannerPostDto[],
  timeZone: string,
): Record<string, PlannerPostDto[]> {
  const byDate: Record<string, PlannerPostDto[]> = {};
  for (const post of list) {
    if (!post.occurredAt) continue;
    const key = zonedClock(new Date(post.occurredAt), timeZone).date;
    (byDate[key] ??= []).push(post);
  }
  return byDate;
}
