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
} from '@nestjs/common';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto, UpdateFeedbackStatusDto } from './dto';
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
  ) {
    return this.feedbackService.findAllPublic(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  /**
   * Get public stats (average rating, total approved reviews)
   */
  @Get('stats/public')
  async getPublicStats() {
    const stats = await this.feedbackService.getStats();
    return {
      totalReviews: stats.approved,
      averageRating: stats.averageRating,
    };
  }

  // ==================== Authenticated User Endpoints ====================

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
  ) {
    return this.feedbackService.findAllAdmin(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      status,
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
