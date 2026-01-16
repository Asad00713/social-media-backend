import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  /**
   * Get all notifications for the current user (paginated)
   */
  @Get()
  async findAll(
    @Request() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notificationsService.findAllByUser(
      req.user.userId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      unreadOnly === 'true',
    );
  }

  /**
   * Get unread notification count
   */
  @Get('unread-count')
  async getUnreadCount(@Request() req) {
    const count = await this.notificationsService.getUnreadCount(req.user.userId);
    return { unreadCount: count };
  }

  /**
   * Mark a single notification as read
   */
  @Patch(':id/read')
  async markAsRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req,
  ) {
    const notification = await this.notificationsService.markAsRead(
      id,
      req.user.userId,
    );

    // Send updated unread count via WebSocket
    const unreadCount = await this.notificationsService.getUnreadCount(
      req.user.userId,
    );
    this.notificationsGateway.sendUnreadCountUpdate(req.user.userId, unreadCount);

    return notification;
  }

  /**
   * Mark multiple notifications as read
   */
  @Patch('mark-read')
  async markMultipleAsRead(
    @Body() body: { notificationIds: string[] },
    @Request() req,
  ) {
    const count = await this.notificationsService.markMultipleAsRead(
      body.notificationIds,
      req.user.userId,
    );

    // Send updated unread count via WebSocket
    const unreadCount = await this.notificationsService.getUnreadCount(
      req.user.userId,
    );
    this.notificationsGateway.sendUnreadCountUpdate(req.user.userId, unreadCount);

    return { markedCount: count };
  }

  /**
   * Mark all notifications as read
   */
  @Patch('mark-all-read')
  async markAllAsRead(@Request() req) {
    const count = await this.notificationsService.markAllAsRead(req.user.userId);

    // Send updated unread count via WebSocket
    this.notificationsGateway.sendUnreadCountUpdate(req.user.userId, 0);

    return { markedCount: count };
  }

  /**
   * Delete a notification
   */
  @Delete(':id')
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req,
  ) {
    const deleted = await this.notificationsService.delete(id, req.user.userId);

    // Send updated unread count via WebSocket
    const unreadCount = await this.notificationsService.getUnreadCount(
      req.user.userId,
    );
    this.notificationsGateway.sendUnreadCountUpdate(req.user.userId, unreadCount);

    return { deleted };
  }

  /**
   * Delete all notifications
   */
  @Delete()
  async deleteAll(@Request() req) {
    const count = await this.notificationsService.deleteAll(req.user.userId);

    // Send updated unread count via WebSocket
    this.notificationsGateway.sendUnreadCountUpdate(req.user.userId, 0);

    return { deletedCount: count };
  }
}
