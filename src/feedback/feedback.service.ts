import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import type { DbType } from 'src/drizzle/db';
import { feedback, Feedback, FeedbackStatus } from 'src/drizzle/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';

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

@Injectable()
export class FeedbackService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async create(
    createFeedbackDto: CreateFeedbackDto,
    userId: string,
  ): Promise<Feedback> {
    // Check if user already submitted feedback
    const existingFeedback = await this.db.query.feedback.findFirst({
      where: eq(feedback.userId, userId),
    });

    if (existingFeedback) {
      throw new ConflictException('You have already submitted feedback');
    }

    const [newFeedback] = await this.db
      .insert(feedback)
      .values({
        userId,
        rating: createFeedbackDto.rating,
        comment: createFeedbackDto.comment || null,
      })
      .returning();

    return newFeedback;
  }

  async findAllPublic(
    page: number = 1,
    limit: number = 10,
  ): Promise<PaginatedFeedback> {
    const offset = (page - 1) * limit;

    // Only return approved feedback for public view
    const feedbackList = await this.db.query.feedback.findMany({
      where: eq(feedback.status, 'approved'),
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
      .where(eq(feedback.status, 'approved'));

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
  ): Promise<PaginatedFeedback> {
    const offset = (page - 1) * limit;

    const conditions = status ? eq(feedback.status, status) : undefined;

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

    const countQuery = status
      ? this.db
          .select({ count: sql<number>`count(*)` })
          .from(feedback)
          .where(eq(feedback.status, status))
      : this.db.select({ count: sql<number>`count(*)` }).from(feedback);

    const [{ count }] = await countQuery;

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

  async getStats(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    averageRating: number;
  }> {
    const [totalResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback);

    const [pendingResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .where(eq(feedback.status, 'pending'));

    const [approvedResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .where(eq(feedback.status, 'approved'));

    const [rejectedResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .where(eq(feedback.status, 'rejected'));

    const [avgResult] = await this.db
      .select({ avg: sql<number>`COALESCE(AVG(rating), 0)` })
      .from(feedback)
      .where(eq(feedback.status, 'approved'));

    return {
      total: Number(totalResult.count),
      pending: Number(pendingResult.count),
      approved: Number(approvedResult.count),
      rejected: Number(rejectedResult.count),
      averageRating: Number(Number(avgResult.avg).toFixed(1)),
    };
  }
}
