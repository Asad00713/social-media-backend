import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import type { DbType } from 'src/drizzle/db';
import { feedback, Feedback, FeedbackStatus, users } from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { NotificationEmitterService } from 'src/notifications/notification-emitter.service';

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

/** A user's own reviews, keyed by type so callers can do a property lookup. */
export interface MyFeedback {
  app: Feedback | null;
  maestro: Feedback | null;
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
    // One review per user PER TYPE — rating the app does not consume the
    // user's chance to rate Maestro.
    const existingFeedback = await this.db.query.feedback.findFirst({
      where: and(
        eq(feedback.userId, userId),
        eq(feedback.type, createFeedbackDto.type),
      ),
    });

    if (existingFeedback) {
      throw new ConflictException('You have already submitted feedback');
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

    // Only return approved feedback for public view
    const feedbackList = await this.db.query.feedback.findMany({
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
      limit,
      offset,
    });

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .where(publicWhere);

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

    const total = await countWhere();
    const pending = await countWhere(eq(feedback.status, 'pending'));
    const approved = await countWhere(eq(feedback.status, 'approved'));
    const rejected = await countWhere(eq(feedback.status, 'rejected'));

    const avgWhere = withType(eq(feedback.status, 'approved'));
    const [avgResult] = await this.db
      .select({ avg: sql<number>`COALESCE(AVG(rating), 0)` })
      .from(feedback)
      .where(avgWhere!);

    return {
      total,
      pending,
      approved,
      rejected,
      averageRating: Number(Number(avgResult.avg).toFixed(1)),
    };
  }

  /**
   * The caller's own reviews, keyed by type. Backs the widget's "have I
   * already submitted?" check — server-side truth, so the answer survives a
   * change of browser where localStorage would not.
   */
  async findMine(userId: string): Promise<MyFeedback> {
    const rows = await this.db.query.feedback.findMany({
      where: eq(feedback.userId, userId),
    });

    return {
      app: rows.find((r) => r.type === 'app') ?? null,
      maestro: rows.find((r) => r.type === 'maestro') ?? null,
    };
  }
}
