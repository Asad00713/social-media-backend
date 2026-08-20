import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import type { DbType } from 'src/drizzle/db';
import {
  feedback,
  Feedback,
  FeedbackStatus,
  users,
  feedbackDismissals,
} from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { NotificationEmitterService } from 'src/notifications/notification-emitter.service';
import { promptFor } from './feedback-eligibility';

export interface FeedbackWithUser extends Feedback {
  user: {
    id: string;
    name: string | null;
    email: string;
  };
}

export interface PaginatedFeedback {
  data: FeedbackWithUser[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * What the widget needs: whether to prompt, for what, and when it could next
 * become eligible. A single `prompt` rather than a flag per type — the global
 * throttle is then enforced by the response shape, not by client discipline.
 */
export interface MyFeedback {
  prompt: FeedbackType | null;
  nextEligibleAt: string | null;
  latest: {
    app: Feedback | null;
    maestro: Feedback | null;
  };
}

@Injectable()
export class FeedbackService {
  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private notificationEmitter: NotificationEmitterService,
  ) {}

  async create(
    createFeedbackDto: CreateFeedbackDto,
    userId: string,
  ): Promise<Feedback> {
    // The unique (user_id, type) index is gone, so the service is now the only
    // guard. Without this a stale or hostile client could submit unlimited
    // reviews and skew the public average.
    const mine = await this.findMine(userId);
    if (mine.prompt !== createFeedbackDto.type) {
      throw new ConflictException(
        'You have already shared feedback recently. Thank you!',
      );
    }

    let newFeedback: Feedback;
    try {
      [newFeedback] = await this.db
        .insert(feedback)
        .values({
          userId,
          type: createFeedbackDto.type,
          rating: createFeedbackDto.rating,
          comment: createFeedbackDto.comment || null,
        })
        .returning();
    } catch (error) {
      // The check above is read-then-write, so two concurrent submits can both
      // pass it. The unique index is the real guard; translate its violation
      // into the same friendly 409 rather than a 500.
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('You have already submitted feedback');
      }
      throw error;
    }

    // Notify super admins about new feedback
    await this.notifySuperAdmins(userId, createFeedbackDto.rating);

    return newFeedback;
  }

  /**
   * Notify super admins about new feedback
   */
  private async notifySuperAdmins(userId: string, rating: number) {
    try {
      // Get user name for notification
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { name: true, email: true },
      });

      // Get all super admins
      const superAdmins = await this.db.query.users.findMany({
        where: eq(users.role, 'SUPER_ADMIN'),
        columns: { id: true },
      });

      // Notify each super admin
      for (const admin of superAdmins) {
        await this.notificationEmitter.newFeedbackSubmitted(
          admin.id,
          rating,
          user?.name || user?.email || 'A user',
        );
      }
    } catch (error) {
      // Don't fail the feedback creation if notification fails
      console.error('Failed to notify admins about new feedback:', error);
    }
  }

  async findAllPublic(
    page: number = 1,
    limit: number = 10,
    type: FeedbackType = 'app',
  ): Promise<PaginatedFeedback> {
    const offset = (page - 1) * limit;

    const publicWhere = and(
      eq(feedback.status, 'approved'),
      eq(feedback.type, type),
    );

    // One vote per user: with recurring reviews, counting every approved row
    // would let a long-tenured user dominate the public list and average.
    // Fetched via the query builder rather than a raw DISTINCT ON — the
    // public list is small and already moderated, and reducing to
    // newest-per-user in TypeScript avoids fighting this Drizzle version's
    // node-postgres `execute()` return shape (a pg QueryResult with `.rows`,
    // not a bare row array) for what is otherwise a query-builder read.
    const approvedRows = await this.db.query.feedback.findMany({
      where: publicWhere,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: [desc(feedback.createdAt)],
    });

    const latestPerUser = newestPerUser(approvedRows as FeedbackWithUser[]);
    const total = latestPerUser.length;
    const data = latestPerUser.slice(offset, offset + limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findAllAdmin(
    page: number = 1,
    limit: number = 10,
    status?: FeedbackStatus,
    type?: FeedbackType,
  ): Promise<PaginatedFeedback> {
    const offset = (page - 1) * limit;

    const filters = [
      status ? eq(feedback.status, status) : undefined,
      type ? eq(feedback.type, type) : undefined,
    ].filter((filter): filter is SQL => filter !== undefined);
    const conditions = filters.length ? and(...filters) : undefined;

    const feedbackList = await this.db.query.feedback.findMany({
      where: conditions,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: [desc(feedback.createdAt)],
      limit,
      offset,
    });

    const countBase = this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback);
    const [{ count }] = await (conditions
      ? countBase.where(conditions)
      : countBase);

    return {
      data: feedbackList as FeedbackWithUser[],
      pagination: {
        page,
        limit,
        total: Number(count),
        totalPages: Math.ceil(Number(count) / limit),
      },
    };
  }

  async findOne(id: string): Promise<FeedbackWithUser> {
    const result = await this.db.query.feedback.findFirst({
      where: eq(feedback.id, id),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!result) {
      throw new NotFoundException(`Feedback with ID ${id} not found`);
    }

    return result as FeedbackWithUser;
  }

  async updateStatus(
    id: string,
    updateStatusDto: UpdateFeedbackStatusDto,
  ): Promise<Feedback> {
    const existingFeedback = await this.db.query.feedback.findFirst({
      where: eq(feedback.id, id),
    });

    if (!existingFeedback) {
      throw new NotFoundException(`Feedback with ID ${id} not found`);
    }

    const [updatedFeedback] = await this.db
      .update(feedback)
      .set({
        status: updateStatusDto.status,
        adminNotes: updateStatusDto.adminNotes,
        updatedAt: new Date(),
      })
      .where(eq(feedback.id, id))
      .returning();

    return updatedFeedback;
  }

  async delete(id: string): Promise<{ message: string }> {
    const existingFeedback = await this.db.query.feedback.findFirst({
      where: eq(feedback.id, id),
    });

    if (!existingFeedback) {
      throw new NotFoundException(`Feedback with ID ${id} not found`);
    }

    await this.db.delete(feedback).where(eq(feedback.id, id));

    return { message: 'Feedback deleted successfully' };
  }

  async getStats(type?: FeedbackType): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    averageRating: number;
  }> {
    const typeFilter = type ? eq(feedback.type, type) : undefined;
    const withType = (extra?: SQL) => {
      const parts = [typeFilter, extra].filter(
        (part): part is SQL => part !== undefined,
      );
      return parts.length ? and(...parts) : undefined;
    };

    const countWhere = async (extra?: SQL) => {
      const base = this.db
        .select({ count: sql<number>`count(*)` })
        .from(feedback);
      const where = withType(extra);
      const [row] = await (where ? base.where(where) : base);
      return Number(row.count);
    };

    // These four describe the moderation queue, so every row counts — a user
    // who has re-reviewed is genuinely three items in that queue's history.
    const total = await countWhere();
    const pending = await countWhere(eq(feedback.status, 'pending'));
    const approved = await countWhere(eq(feedback.status, 'approved'));
    const rejected = await countWhere(eq(feedback.status, 'rejected'));

    // The average describes sentiment, not queue volume: one vote per user,
    // same rule as the public list.
    const avgWhere = withType(eq(feedback.status, 'approved'));
    const approvedRows = await this.db.query.feedback.findMany({
      where: avgWhere,
    });
    const latestPerUser = newestPerUser(approvedRows as Feedback[]);
    const averageRating = latestPerUser.length
      ? latestPerUser.reduce((sum, r) => sum + r.rating, 0) /
        latestPerUser.length
      : 0;

    return {
      total,
      pending,
      approved,
      rejected,
      averageRating: Number(averageRating.toFixed(1)),
    };
  }

  /**
   * The caller's own reviews plus the current prompt decision. Backs the
   * widget's "should I show a prompt, and for what?" check — server-side
   * truth, so the answer survives a change of browser where localStorage
   * would not.
   */
  async findMine(userId: string): Promise<MyFeedback> {
    const [user, rows, dismissal] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { createdAt: true },
      }),
      this.db.query.feedback.findMany({
        where: eq(feedback.userId, userId),
      }),
      this.db.query.feedbackDismissals.findFirst({
        where: eq(feedbackDismissals.userId, userId),
        orderBy: [desc(feedbackDismissals.dismissedAt)],
      }),
    ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const latest = newestByType(rows);
    const decision = promptFor({
      accountCreatedAt: user.createdAt,
      latestReviewAt: newest(rows.map((r) => r.createdAt)),
      latestDismissalAt: dismissal?.dismissedAt ?? null,
      latestByType: {
        app: latest.app?.createdAt ?? null,
        maestro: latest.maestro?.createdAt ?? null,
      },
      now: new Date(),
    });

    return {
      prompt: decision.prompt,
      nextEligibleAt: decision.nextEligibleAt?.toISOString() ?? null,
      latest,
    };
  }

  /**
   * Record that the user closed the prompt without answering. Upserted — only
   * the most recent dismissal per (user, type) matters.
   */
  async dismiss(userId: string, type: FeedbackType): Promise<void> {
    await this.db
      .insert(feedbackDismissals)
      .values({ userId, type })
      .onConflictDoUpdate({
        target: [feedbackDismissals.userId, feedbackDismissals.type],
        set: { dismissedAt: new Date() },
      });
  }
}

/** The newest date in a list, or null for an empty list. */
function newest(dates: Date[]): Date | null {
  return dates.reduce<Date | null>(
    (max, d) => (max === null || d > max ? d : max),
    null,
  );
}

/**
 * The newest row for each type. Explicitly sorts rather than trusting row
 * order: with the unique index dropped there may be many rows per type, and
 * the driver makes no ordering promise.
 */
function newestByType(rows: Feedback[]): {
  app: Feedback | null;
  maestro: Feedback | null;
} {
  const pick = (type: FeedbackType): Feedback | null =>
    rows
      .filter((r) => r.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;

  return { app: pick('app'), maestro: pick('maestro') };
}

/**
 * The newest row per user, newest-first. Backs "one vote per user" for the
 * public list and its average — with recurring reviews a single user may
 * have many approved rows over time, and only their latest should count.
 */
function newestPerUser<T extends { userId: string; createdAt: Date }>(
  rows: T[],
): T[] {
  const byUser = new Map<string, T>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (!existing || row.createdAt > existing.createdAt) {
      byUser.set(row.userId, row);
    }
  }
  return [...byUser.values()].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
