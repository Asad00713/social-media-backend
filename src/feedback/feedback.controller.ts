import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ParseEnumPipe,
} from '@nestjs/common';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto, UpdateFeedbackStatusDto } from './dto';
import { FEEDBACK_TYPE } from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminGuard } from 'src/auth/guards/admin.guard';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  // ==================== Public Endpoints ====================

  /**
   * Get all approved feedback (public)
   */
  @Get()
  async findAllPublic(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type', new ParseEnumPipe(FEEDBACK_TYPE, { optional: true }))
    type?: FeedbackType,
  ) {
    return this.feedbackService.findAllPublic(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      // Public surfaces show app reviews unless asked otherwise — mixing types
      // would produce an average that describes neither.
      type ?? 'app',
    );
  }

  /**
   * Get public stats (average rating, total approved reviews)
   */
  @Get('stats/public')
  async getPublicStats(
    @Query('type', new ParseEnumPipe(FEEDBACK_TYPE, { optional: true }))
    type?: FeedbackType,
  ) {
    const stats = await this.feedbackService.getStats(type ?? 'app');
    return {
      totalReviews: stats.approved,
      averageRating: stats.averageRating,
    };
  }

  // ==================== Authenticated User Endpoints ====================

  /**
   * The caller's own reviews, keyed by type. The widget calls this to decide
   * whether to render at all.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async findMine(@Request() req) {
    return this.feedbackService.findMine(req.user.userId);
  }

  /**
   * Submit feedback (authenticated users only)
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() createFeedbackDto: CreateFeedbackDto, @Request() req) {
    return this.feedbackService.create(createFeedbackDto, req.user.userId);
  }

  // ==================== Admin Endpoints ====================

  /**
   * Get all feedback with filters (admin only)
   */
  @Get('admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async findAllAdmin(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'pending' | 'approved' | 'rejected',
    @Query('type', new ParseEnumPipe(FEEDBACK_TYPE, { optional: true }))
    type?: FeedbackType,
  ) {
    return this.feedbackService.findAllAdmin(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      status,
      // No default — admins see every type unless they filter.
      type,
    );
  }

  /**
   * Get full stats (admin only)
   */
  @Get('admin/stats')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getAdminStats() {
    return this.feedbackService.getStats();
  }

  /**
   * Get single feedback by ID (admin only)
   */
  @Get('admin/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.feedbackService.findOne(id);
  }

  /**
   * Update feedback status (approve/reject) - admin only
   */
  @Patch('admin/:id/status')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateStatusDto: UpdateFeedbackStatusDto,
  ) {
    return this.feedbackService.updateStatus(id, updateStatusDto);
  }

  /**
   * Delete feedback (admin only)
   */
  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.feedbackService.delete(id);
  }
}
