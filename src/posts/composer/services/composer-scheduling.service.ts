import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { carryFirstWeekMeta } from '../../../first-week/lib/first-week-metadata';
import { randomUUID } from 'node:crypto';
import {
  approvalForPart,
  assertApprovedFor,
  assertPolicyAllowsDirectSend,
  canonicalJson,
  carryApproval,
  contentFingerprint,
  type ApprovableContent,
} from '../../lib/draft-approval';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import { QUEUES } from '../../../queue/queue.module';
import type { ScheduleDraftDto } from '../dto/schedule-draft.dto';
import type { ChannelTarget } from '../types/draft.types';
import {
  PER_CHANNEL_WITH_REPEAT,
  SCHEDULE_GROUP_KEY,
  carryScheduleGroup,
  groupByInstant,
  overridesFor,
  readScheduleGroup,
  type ScheduleGroup,
} from '../lib/per-channel-schedule';
import { resolveOrganise } from '../lib/draft-organise';
import { PostLabelsService } from '../../../labels/post-labels.service';
import { assertNoOpenBlanks } from '../lib/template-blanks';
import { snapshotOf } from '../lib/draft-versions';
import { ApprovalPolicyService } from './approval-policy.service';
import { DraftVersionsService } from './draft-versions.service';
import { CalendarPushSyncService } from '../../../calendar-sync/services/calendar-push-sync.service';
import { PostQueueService } from '../../../billing/services/post-queue.service';
import { loadWorkspaceTimezone } from '../../../planner/lib/workspace-time';
import { parseRule, startSeries } from '../../lib/recurrence';
import { parseVariationSources } from '../../lib/rotating-variations';
import { livePosts } from '../../soft-delete/soft-delete';

export interface ScheduleResult {
  postId: string;
  /** The earliest time, when the post was split by "a time per channel". */
  scheduledAt: string;
  status: 'scheduled';
  /**
   * Only when the draft was split into one post per distinct time: every
   * sibling, earliest first (the first is `postId`), and their family id.
   */
  siblings?: Array<{
    postId: string;
    scheduledAt: string;
    channelIds: string[];
  }>;
  scheduleGroupId?: string;
}

type LegacyTarget = ChannelTarget & { status: string };

/** The columns of the draft's own row the split path reads. */
interface StoredPost {
  status: string | null;
  createdById: string | null;
  metadata: unknown;
  targets: unknown;
  jobId: string | null;
  content: string | null;
  mediaItems: unknown;
  platformContent: unknown;
}

/** The shared metadata keys the publishers read (see sharedMetadata). */
const SHARED_PUBLISH_KEYS = [
  'hashtags',
  'mentions',
  'linkPreview',
  'title',
] as const;

/** The server-owned series state on a stored repeat rule. */
const SERIES_STATE_KEYS = [
  'seriesId',
  'occurrence',
  'anchorDate',
  'time',
  'variations',
];

/**
 * Besides the approvable content, what a pure re-time must leave unchanged
 * for the approval policy to let it through.
 */
interface PublishExtras {
  shared: Record<string, unknown>;
  /** The repeat rule without its series state; null for no repeat. */
  rule: unknown;
  /** The rotating variations; left out when the request keeps the stored ones. */
  variations?: unknown;
}

function pickShared(metadata: unknown): Record<string, unknown> {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SHARED_PUBLISH_KEYS) out[key] = m[key];
  return out;
}

function ruleOf(recurrence: unknown): unknown {
  if (!recurrence || typeof recurrence !== 'object') return null;
  const rule: Record<string, unknown> = { ...(recurrence as object) };
  for (const key of SERIES_STATE_KEYS) delete rule[key];
  return rule;
}

/** The stored row's extras, shaped like the request's for comparison. */
function storedExtras(
  metadata: unknown,
  outgoing: PublishExtras,
): PublishExtras {
  const recurrence = (
    (metadata ?? {}) as { schedule?: { recurrence?: { variations?: unknown } } }
  ).schedule?.recurrence;
  return {
    shared: pickShared(metadata),
    rule: ruleOf(recurrence),
    ...('variations' in outgoing
      ? { variations: recurrence?.variations ?? null }
      : {}),
  };
}

/** What the approval-policy check reads from a stored row. */
type PolicyRow = Pick<
  StoredPost,
  | 'status'
  | 'metadata'
  | 'content'
  | 'mediaItems'
  | 'platformContent'
  | 'targets'
>;

/**
 * The legacy posts.targets shape (PostTarget) — status='draft' per channel
 * until the worker fires, when PostService.publishPost flips them to
 * 'publishing' then 'published' / 'failed'. A channel's own `scheduleAt` is
 * not kept: the row's `scheduled_at` is its time.
 */
function legacyTargetsOf(channels: ChannelTarget[]): LegacyTarget[] {
  return channels.map<LegacyTarget>((c) => ({
    channelId: c.channelId,
    platform: c.platform,
    publishStatus: 'queued',
    retryCount: 0,
    status: 'draft', // legacy PostTarget.status — required by PostService.publishPost
  }));
}

/** The metadata every scheduled row starts from. */
function sharedMetadata(dto: ScheduleDraftDto): Record<string, unknown> {
  return {
    hashtags: dto.base.hashtags,
    mentions: dto.base.mentions,
    linkPreview: dto.base.linkPreview,
    title: dto.title,
    source: 'composer',
  };
}

/**
 * Stores a draft as scheduled and enqueues a BullMQ delayed job that fires
 * at scheduledAt. The processor (PostPublishProcessor) then drives the
 * legacy PostService.publishPost flow — which delegates per-platform work
 * to PublisherFactory just like the immediate publish path.
 */
@Injectable()
export class ComposerSchedulingService {
  private readonly logger = new Logger(ComposerSchedulingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
    private readonly calendarPushSync: CalendarPushSyncService,
    private readonly postQueue: PostQueueService,
    // Optional so a unit test can build the service without it.
    @Optional() private readonly versions?: DraftVersionsService,
    // Not @Optional: the module must provide it. Optional in the type only so
    // a unit test that never touches labels can leave it out.
    private readonly postLabels?: PostLabelsService,
    // Not @Optional either; optional in the type for the same reason.
    private readonly approvalPolicy?: ApprovalPolicyService,
  ) {}

  /**
   * The workspace approval policy for one send. A pure time move of a post
   * that is already scheduled is not gated, as in PostService.updatePost: it
   * may predate the policy, and moving it sends nothing new. It is pure only
   * when nothing that reaches the publishers changes: the content fingerprint
   * (content, media, per-channel content, channels) AND the extras (the
   * shared metadata, the repeat rule and the rotating variations).
   */
  private async assertPolicyAllows(
    workspaceId: string,
    userId: string,
    stored: PolicyRow | undefined,
    outgoing: ApprovableContent,
    outgoingExtras: PublishExtras,
  ): Promise<void> {
    if (
      stored?.status === 'scheduled' &&
      contentFingerprint({
        ...stored,
        targets: stored.targets as ApprovableContent['targets'],
      }) === contentFingerprint(outgoing) &&
      canonicalJson(storedExtras(stored.metadata, outgoingExtras)) ===
        canonicalJson(outgoingExtras)
    ) {
      return;
    }
    assertPolicyAllowsDirectSend(
      (await this.approvalPolicy?.coversAuthor(workspaceId, userId)) ?? false,
      stored?.metadata,
    );
  }

  /**
   * Labels on a post that is already scheduled or published. Best-effort: the
   * post and its job (or publish) are done by now, so a label failure must not
   * turn them into a 500 the client would retry. Logged, never thrown.
   */
  private async setLabelsAfter(
    workspaceId: string,
    postId: string,
    labels: string[] | null,
  ): Promise<void> {
    try {
      await this.postLabels?.setForPost(workspaceId, postId, labels ?? []);
    } catch (error) {
      this.logger.warn(
        `Labels not saved on post ${postId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async labelSiblings(
    workspaceId: string,
    dto: ScheduleDraftDto,
    stored: StoredPost | undefined,
    siblings: Array<{ id: string }>,
  ): Promise<void> {
    if (dto.labels !== undefined) {
      for (const sibling of siblings) {
        await this.setLabelsAfter(workspaceId, sibling.id, dto.labels);
      }
      return;
    }
    if (!stored || !this.postLabels) return;
    let kept: string[] = [];
    try {
      kept =
        (await this.postLabels.namesForPosts([dto.draftId])).get(dto.draftId) ??
        [];
    } catch (error) {
      this.logger.warn(
        `Labels not copied from post ${dto.draftId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (kept.length === 0) return;
    for (const sibling of siblings) {
      if (sibling.id === dto.draftId) continue;
      await this.setLabelsAfter(workspaceId, sibling.id, kept);
    }
  }

  /**
   * Fire-and-forget app→calendar push for a composer-scheduled draft. Mirrors
   * PostService.syncCalendarForPost: never blocks or fails the schedule call —
   * calendar sync is best-effort and self-heals via the 15-min reconcile poll.
   */
  private syncCalendarForPost(postId: string): void {
    void this.calendarPushSync.syncPost(postId).catch((error) => {
      this.logger.warn(
        `Calendar sync failed for scheduled draft ${postId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async schedule(
    workspaceId: string,
    userId: string,
    dto: ScheduleDraftDto,
  ): Promise<ScheduleResult> {
    // A series repeats one time; a time per channel is several.
    if (dto.scheduleMode === 'per_channel' && dto.recurrence != null) {
      throw new BadRequestException(PER_CHANNEL_WITH_REPEAT);
    }
    // Checks every time (`scheduledAt`, or each channel's own) is far enough
    // ahead, then groups the channels by the instant they go out at.
    const groups = groupByInstant(
      dto.scheduleMode,
      dto.scheduledAt,
      dto.channels ?? [],
    );
    if (!dto.channels?.length) {
      throw new BadRequestException(
        'Draft must have at least one channel selected',
      );
    }
    // A template's {{blank}} never goes out, whichever path schedules it.
    assertNoOpenBlanks({
      base: dto.base,
      perPlatform: dto.perPlatform as Record<string, unknown> | undefined,
      platforms: dto.channels.map((c) => c.platform),
    });
    // Several instants: one sibling post per instant. One instant — every
    // channel at the same time, whichever way it was asked for — is the
    // schedule as it always was, below.
    if (groups.length > 1) {
      return this.scheduleSplit(workspaceId, userId, dto, groups);
    }
    const scheduledAt = groups[0].at;
    const delay = scheduledAt.getTime() - Date.now();
    const rule =
      dto.recurrence === undefined || dto.recurrence === null
        ? null
        : parseRule(dto.recurrence);
    if (dto.recurrence != null && !rule) {
      throw new BadRequestException('recurrence is not a valid repeat rule');
    }
    // Only a rotating repeat reads them; a picked channel and a platform the
    // post is not on are dropped, a malformed value is refused.
    const variations =
      rule?.rotateVariations && dto.variationSources !== undefined
        ? parseVariationSources(dto.variationSources, {
            platforms: dto.channels.map((c) => c.platform),
            perPlatform: dto.perPlatform,
          })
        : undefined;
    if (variations === null) {
      throw new BadRequestException('variationSources is not valid');
    }

    // Build the legacy posts.targets shape (PostTarget) — status='draft' per
    // channel until the worker fires, when PostService.publishPost flips
    // them to 'publishing' then 'published' / 'failed'.
    const legacyTargets = legacyTargetsOf(dto.channels);

    // Shared keys only. Per-platform fields (X's thread and poll, every
    // other channel's settings) stay in `platformContent[platform]
    // .platformSpecific`, which the scheduled publish hands to that
    // platform's publisher alone. Copying X's thread up here gave it to
    // every channel on the post.
    const metadata: Record<string, unknown> = sharedMetadata(dto);

    // Upsert posts row in 'scheduled' state.
    const existing = await this.db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, dto.draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      )
      .limit(1);

    // A first-week draft keeps its tag when scheduled from the composer (the
    // composer's own `source: 'composer'` above would otherwise erase it).
    Object.assign(metadata, carryFirstWeekMeta(existing[0]?.metadata));
    // A sibling of a split post stays in its family when re-scheduled.
    Object.assign(metadata, carryScheduleGroup(existing[0]?.metadata));
    // Campaign: absent keeps the stored value (see draft-organise). Labels go
    // to post_labels once the row is written.
    Object.assign(
      metadata,
      await resolveOrganise(this.db, workspaceId, existing[0]?.metadata, dto),
    );

    // A repeating post keeps its rule with the series state the server owns.
    // A post already in a series stays in it (same seriesId and place), so
    // re-scheduling it does not restart an "after N posts" count. Without a
    // rule, no `schedule` key is written — exactly as before. Written before
    // the approval check: the repeat rule is part of what an approval covers.
    if (rule) {
      const timezone = await loadWorkspaceTimezone(this.db, workspaceId);
      metadata.schedule = {
        mode: 'all_same_time',
        scheduleAt: scheduledAt.toISOString(),
        recurrence: startSeries(
          rule,
          dto.draftId,
          scheduledAt,
          timezone,
          (existing[0]?.metadata as Record<string, any> | undefined)?.schedule
            ?.recurrence,
          variations,
        ),
      };
    }

    // "Needs approval": refused before any write or job unless an approval
    // covers exactly what is being scheduled — the shared metadata and the
    // repeat rule included. The approval then rides along on the scheduled
    // row, so unscheduling keeps it.
    const outgoing: ApprovableContent = {
      content: dto.base.text,
      mediaItems: dto.base.mediaItems,
      platformContent: dto.perPlatform ?? {},
      targets: dto.channels,
      metadata,
    };
    await this.assertPolicyAllows(workspaceId, userId, existing[0], outgoing, {
      shared: pickShared(metadata),
      rule: rule ?? null,
      ...(variations === undefined ? {} : { variations }),
    });
    assertApprovedFor(existing[0]?.metadata, outgoing);
    Object.assign(metadata, carryApproval(existing[0]?.metadata, outgoing));

    // The same per-channel queue ceiling PostService.createPost enforces. This
    // is a second, independent path to `status: 'scheduled'`, so a check on
    // only the other one would be bypassable by using this composer.
    //
    // Skipped when the draft is ALREADY scheduled (a re-schedule): its own row
    // is inside countQueuedForChannel's count, so it would be refused for
    // occupying the slot it already holds.
    if (existing[0]?.status !== 'scheduled') {
      await this.postQueue.enforceQueueLimit(
        workspaceId,
        dto.channels.map((c) => String(c.channelId)),
      );
    }

    if (existing.length === 0) {
      await this.db.insert(posts).values({
        id: dto.draftId,
        workspaceId,
        createdById: userId,
        content: dto.base.text,
        mediaItems: dto.base.mediaItems as any,
        targets: legacyTargets as any,
        status: 'scheduled',
        scheduledAt,
        platformContent: (dto.perPlatform ?? {}) as any,
        metadata: metadata as any,
      });
    } else {
      await this.db
        .update(posts)
        .set({
          content: dto.base.text,
          mediaItems: dto.base.mediaItems as any,
          targets: legacyTargets as any,
          status: 'scheduled',
          scheduledAt,
          platformContent: (dto.perPlatform ?? {}) as any,
          metadata: metadata as any,
          updatedAt: new Date(),
        })
        .where(
          and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)),
        );
    }

    // Remove any prior delayed job for this draft (e.g. user re-schedules) —
    // both the composer's own and whatever job posts.job_id names (a
    // PostService-scheduled job), or the old one would still fire.
    const jobId = `composer-publish-${dto.draftId}`;
    await this.removeJobs(jobId, existing[0]?.jobId);

    const job = await this.publishingQueue.add(
      'publish',
      { postId: dto.draftId },
      { jobId, delay, attempts: 3 },
    );

    // Record the job on the row: PostService.updatePost/deletePost cancel by
    // posts.job_id, so an unrecorded job cannot be cancelled when the post is
    // moved and would publish at its old time.
    await this.db
      .update(posts)
      .set({ jobId: String(job?.id ?? jobId) })
      .where(
        and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)),
      );

    this.logger.log(
      `Scheduled draft ${dto.draftId} for ${scheduledAt.toISOString()} (delay=${delay}ms)`,
    );

    // Labels once the job is recorded ("absent keeps, present sets"; null =
    // none), so a label failure never leaves the row without its job.
    if (dto.labels !== undefined) {
      await this.setLabelsAfter(workspaceId, dto.draftId, dto.labels);
    }

    // In the 2026 composer, scheduling is how a draft reaches the server,
    // so it is a save for version history too.
    await this.versions?.record(dto.draftId, userId, snapshotOf(dto));

    // Reflect the newly scheduled post on connected calendars immediately —
    // otherwise it only appears on the next 15-min reconcile poll.
    this.syncCalendarForPost(dto.draftId);

    return {
      postId: dto.draftId,
      scheduledAt: scheduledAt.toISOString(),
      status: 'scheduled',
    };
  }

  /**
   * "Different time for each channel" with more than one distinct time:
   * one sibling `posts` row per time, each holding only its own channels
   * and their per-platform content (captions, settings, first comments,
   * thread, media), each with its own single publish job, all sharing
   * `metadata.scheduleGroupId`. The earliest keeps the draft's id.
   *
   * Every guard the one-row path runs is run for every sibling, and all of
   * them before the first write: a refusal leaves nothing half-scheduled.
   * Afterwards each sibling is an ordinary scheduled post — see
   * SCHEDULE_GROUP_EDITS in lib/per-channel-schedule.ts.
   */
  private async scheduleSplit(
    workspaceId: string,
    userId: string,
    dto: ScheduleDraftDto,
    groups: ScheduleGroup[],
  ): Promise<ScheduleResult> {
    const existing: StoredPost[] = await this.db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, dto.draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      )
      .limit(1);
    const stored = existing[0] as StoredPost | undefined;

    const groupId = readScheduleGroup(stored?.metadata) ?? randomUUID();
    const shared: Record<string, unknown> = {
      ...sharedMetadata(dto),
      // First-week tag and campaign go to every sibling; labels below.
      ...carryFirstWeekMeta(stored?.metadata),
      ...(await resolveOrganise(this.db, workspaceId, stored?.metadata, dto)),
      [SCHEDULE_GROUP_KEY]: groupId,
    };

    const whole: ApprovableContent = {
      content: dto.base.text,
      mediaItems: dto.base.mediaItems,
      platformContent: dto.perPlatform ?? {},
      targets: dto.channels,
      metadata: shared,
    };
    // The policy, once for the whole; approvalForPart then runs
    // assertApprovedFor for the whole and for each part.
    // A time per channel never repeats (refused above), so no rule.
    await this.assertPolicyAllows(workspaceId, userId, stored, whole, {
      shared: pickShared(shared),
      rule: null,
    });

    const siblings = groups.map((group, i) => {
      const perPlatform = overridesFor(dto.perPlatform, group.channels);
      const metadata: Record<string, unknown> = {
        ...shared,
        // "Needs approval", refused here for the whole and for this part.
        ...approvalForPart(stored?.metadata, whole, {
          content: dto.base.text,
          mediaItems: dto.base.mediaItems,
          platformContent: perPlatform,
          targets: group.channels,
          metadata: shared,
        }),
      };
      return {
        id: i === 0 ? dto.draftId : randomUUID(),
        at: group.at,
        channels: group.channels,
        perPlatform,
        metadata,
      };
    });

    // The per-channel queue ceiling, per sibling. A channel the draft's row
    // already holds a scheduled slot on is not counted again: the row gives
    // that slot up in the update below (the one-row path's re-schedule rule,
    // per channel instead of per row).
    const held = new Set<string>(
      stored?.status === 'scheduled'
        ? ((stored?.targets ?? []) as ChannelTarget[]).map((t) =>
            String(t.channelId),
          )
        : [],
    );
    for (const sibling of siblings) {
      await this.postQueue.enforceQueueLimit(
        workspaceId,
        sibling.channels
          .map((c) => String(c.channelId))
          .filter((id) => !held.has(id)),
      );
    }

    // The rows. New siblings belong to whoever owns the draft, so a Viewer
    // who wrote it still owns every part of it.
    for (const sibling of siblings) {
      const row = {
        content: dto.base.text,
        mediaItems: dto.base.mediaItems as any,
        targets: legacyTargetsOf(sibling.channels) as any,
        status: 'scheduled',
        scheduledAt: sibling.at,
        platformContent: sibling.perPlatform as any,
        metadata: sibling.metadata as any,
      };
      if (sibling.id === dto.draftId && stored) {
        await this.db
          .update(posts)
          .set({ ...row, updatedAt: new Date() })
          .where(
            and(eq(posts.id, sibling.id), eq(posts.workspaceId, workspaceId)),
          );
      } else {
        await this.db.insert(posts).values({
          id: sibling.id,
          workspaceId,
          createdById: stored?.createdById ?? userId,
          ...row,
        });
      }
    }

    // The draft's earlier job (if it was scheduled before) must not fire.
    await this.removeJobs(`composer-publish-${dto.draftId}`, stored?.jobId);

    for (const sibling of siblings) {
      const jobId = `composer-publish-${sibling.id}`;
      const job = await this.publishingQueue.add(
        'publish',
        { postId: sibling.id },
        {
          jobId,
          delay: Math.max(0, sibling.at.getTime() - Date.now()),
          attempts: 3,
        },
      );
      await this.db
        .update(posts)
        .set({ jobId: String(job?.id ?? jobId) })
        .where(
          and(eq(posts.id, sibling.id), eq(posts.workspaceId, workspaceId)),
        );
      // Each sibling is saved content in its own right.
      await this.versions?.record(
        sibling.id,
        userId,
        snapshotOf({
          ...dto,
          perPlatform: sibling.perPlatform,
          channels: sibling.channels,
        }),
      );
      this.syncCalendarForPost(sibling.id);
    }

    // Labels go to every sibling, once every job is recorded. Sent labels are
    // set on each; without them the draft keeps its own and the new siblings
    // get a copy of those.
    await this.labelSiblings(workspaceId, dto, stored, siblings);

    this.logger.log(
      `Scheduled draft ${dto.draftId} as ${siblings.length} posts (group ${groupId}) at ${siblings
        .map((s) => s.at.toISOString())
        .join(', ')}`,
    );

    return {
      postId: dto.draftId,
      scheduledAt: siblings[0].at.toISOString(),
      status: 'scheduled',
      siblings: siblings.map((s) => ({
        postId: s.id,
        scheduledAt: s.at.toISOString(),
        channelIds: s.channels.map((c) => String(c.channelId)),
      })),
      scheduleGroupId: groupId,
    };
  }

  /**
   * Removes the composer's job and, when it is a different job, the one the
   * row records. A job that is already gone is not an error.
   */
  private async removeJobs(
    composerJobId: string,
    recordedJobId?: string | null,
  ): Promise<void> {
    const ids = new Set([composerJobId]);
    if (recordedJobId) ids.add(recordedJobId);
    for (const id of ids) {
      try {
        const job = await this.publishingQueue.getJob(id);
        if (job) await job.remove();
      } catch (error) {
        this.logger.warn(
          `Failed to remove job ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Cancels a scheduled draft — removes the BullMQ job and resets status. */
  async cancel(
    workspaceId: string,
    draftId: string,
  ): Promise<{ success: true }> {
    const [row] = await this.db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      )
      .limit(1);
    await this.removeJobs(`composer-publish-${draftId}`, row?.jobId);

    await this.db
      .update(posts)
      .set({
        status: 'draft',
        scheduledAt: null,
        jobId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));

    // The draft is no longer scheduled — remove its calendar event(s) now
    // instead of waiting for the reconcile poll to prune the stale event.
    void this.calendarPushSync.removePostEvent(draftId).catch((error) => {
      this.logger.warn(
        `Calendar event removal failed for cancelled draft ${draftId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return { success: true };
  }
}
