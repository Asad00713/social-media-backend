import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { posts, type MediaItem } from '../../drizzle/schema/posts.schema';
import {
  PostFailureBatchService,
  postTitle,
  type FailureEntry,
} from '../../email/batching/post-failure-batch.service';
import { networkName } from '../../email/render/components/post-card';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { channelContent } from '../lib/channel-content';
import { PartialPublishError } from '../publishers/base.publisher';
import { TikTokComplianceError } from '../publishers/tiktok-compliance';

interface NotifiableTarget {
  channelId: number | string;
  platform: string;
  status: string;
  errorMessage?: string | null;
}

/** The post fields the notifier reads: a `posts` row satisfies it. */
export interface NotifiablePost {
  id: string;
  workspaceId: string;
  createdById: string | null;
  status: string;
  content: string | null;
  mediaItems?: MediaItem[] | null;
  platformContent?: unknown;
  scheduledAt: Date | null;
  targets: NotifiableTarget[];
}

const NOTIFY_STATUSES = new Set(['failed', 'partially_published']);
/** Shown instead of a message that was never meant for people. */
export const GENERIC_REASON = "Schedura couldn't publish it.";
/** What publishPost stores when the thrown value was not an Error. */
const UNKNOWN_ERROR = 'Unknown error';
/**
 * Driver, ORM and network text: a failed query with its params, a missing
 * relation, a socket error. It can carry SQL and user data.
 */
const INTERNAL_MESSAGE_RE =
  /failed query|\bparams:|relation "[^"]*" does not exist|column "[^"]*" does not exist|violates [a-z ]*constraint|deadlock detected|connection terminated|\bECONN[A-Z]+\b|\bETIMEDOUT\b|\bENOTFOUND\b|getaddrinfo|socket hang up/i;

function looksInternal(message: string): boolean {
  return INTERNAL_MESSAGE_RE.test(message);
}

/**
 * A job error a person may read: a publish refusal (a 4xx HttpException
 * such as "Post has no target channels") or a publisher's own error type.
 * Anything else - a database or network failure - is internal.
 */
function isUserFacingJobError(error: Error): boolean {
  const known =
    (error instanceof HttpException && error.getStatus() < 500) ||
    error instanceof PartialPublishError ||
    error instanceof TikTokComplianceError;
  return known && !!error.message && !looksInternal(error.message);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The picture an email can show: an image, or a video's thumbnail. */
function thumbnailOf(media: MediaItem[]): string | null {
  const first = media[0];
  if (!first) return null;
  if (first.thumbnailUrl) return first.thumbnailUrl;
  return first.type === 'image' ? first.url : null;
}

/**
 * C1 / C1a triggers (spec §6): a scheduled publish that ended failed or
 * partially published, or a publish job that failed for good. Each recipient
 * gets the bell at once and the failure into their 10-minute email window.
 * Never throws: email must not fail or slow a publish.
 */
@Injectable()
export class PublishFailureNotifier {
  private readonly logger = new Logger(PublishFailureNotifier.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly batch: PostFailureBatchService,
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly emitter: NotificationEmitterService,
    private readonly roles: WorkspaceRoleService,
  ) {}

  /** A person pressing "Publish now" sees the result on screen: no email. */
  async onPublishOutcome(
    post: NotifiablePost,
    triggeredBy: string,
  ): Promise<void> {
    if (triggeredBy !== 'scheduler' || !NOTIFY_STATUSES.has(post.status)) {
      return;
    }
    try {
      await this.notifyFailures(
        post,
        post.targets.filter((t) => t.status === 'failed'),
        (t) => this.targetReason(post.id, t.errorMessage),
      );
    } catch (err) {
      this.logger.warn(
        `Post failure notice for ${post.id} failed: ${errorText(err)}`,
      );
    }
  }

  /** Every target that did not go out is reported with the job's error. */
  async onFinalJobFailure(postId: string, error: Error): Promise<void> {
    try {
      const [post] = await this.db
        .select()
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);
      if (!post || post.status === 'published') return;
      let reason = error.message;
      if (!isUserFacingJobError(error)) {
        this.logger.warn(
          `Post ${postId}: final publish error kept out of the notice: ${errorText(error)}`,
        );
        reason = GENERIC_REASON;
      }
      await this.notifyFailures(
        post,
        post.targets.filter((t) => t.status !== 'published'),
        () => reason,
      );
    } catch (err) {
      this.logger.warn(
        `Post failure notice for ${postId} (final job failure) failed: ${errorText(err)}`,
      );
    }
  }

  /**
   * The target's stored errorMessage is what the publisher said, and is kept;
   * an empty one, or one that is internal text, becomes the generic reason.
   */
  private targetReason(
    postId: string,
    message: string | null | undefined,
  ): string {
    if (!message || message === UNKNOWN_ERROR) return GENERIC_REASON;
    if (looksInternal(message)) {
      this.logger.warn(
        `Post ${postId}: target error kept out of the notice: ${message}`,
      );
      return GENERIC_REASON;
    }
    return message;
  }

  private async notifyFailures(
    post: NotifiablePost,
    failed: NotifiableTarget[],
    reasonOf: (t: NotifiableTarget) => string,
  ): Promise<void> {
    if (failed.length === 0) return;
    const ws = post.workspaceId;
    const [userIds, handles] = await Promise.all([
      this.recipientIds(post),
      this.handlesOf(ws, failed),
    ]);
    const otherPublished = [
      ...new Set(
        post.targets
          .filter((t) => t.status === 'published')
          .map((t) => networkName(t.platform)),
      ),
    ];
    const scheduledFor = (post.scheduledAt ?? new Date()).toISOString();

    for (const target of failed) {
      const content = channelContent(post, target.platform);
      const entry: FailureEntry = {
        postId: post.id,
        platform: target.platform,
        handle:
          handles.get(String(target.channelId)) ?? networkName(target.platform),
        caption: content.text,
        thumbnailUrl: thumbnailOf(content.mediaItems),
        scheduledFor,
        reason: reasonOf(target),
        otherPublished,
      };
      for (const userId of userIds) {
        await this.notify.notify({
          userId,
          workspaceId: ws,
          event: 'post_failed',
          bell: () =>
            this.emitter.postFailed(
              userId,
              networkName(target.platform),
              postTitle(entry.caption),
              entry.reason,
            ),
        });
        try {
          await this.batch.record(userId, ws, entry);
        } catch (err) {
          this.logger.warn(
            `Post failure email not batched (post ${post.id}, user ${userId}): ${errorText(err)}`,
          );
        }
      }
    }
  }

  /**
   * The creator, while still a member, then the owner and ADMINs: one entry
   * per person.
   */
  private async recipientIds(post: NotifiablePost): Promise<string[]> {
    const ids: string[] = [];
    const creator = post.createdById;
    if (creator && (await this.roles.getRole(post.workspaceId, creator))) {
      ids.push(creator);
    }
    for (const admin of await this.recipients.admins(post.workspaceId)) {
      if (!ids.includes(admin.id)) ids.push(admin.id);
    }
    return ids;
  }

  /** channelId -> '@username', else the account name. */
  private async handlesOf(
    workspaceId: string,
    targets: NotifiableTarget[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        targets
          .map((t) => parseInt(String(t.channelId), 10))
          .filter((id) => Number.isFinite(id)),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        username: socialMediaChannels.username,
        accountName: socialMediaChannels.accountName,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          inArray(socialMediaChannels.id, ids),
        ),
      );
    return new Map(
      rows.map((r) => [
        String(r.id),
        r.username ? `@${r.username.replace(/^@/, '')}` : r.accountName,
      ]),
    );
  }
}
