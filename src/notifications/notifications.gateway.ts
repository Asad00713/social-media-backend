import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Notification } from 'src/drizzle/schema';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*', // Configure this based on your frontend URL in production
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  // Map to track connected users: userId -> Set of socket IDs
  private connectedUsers: Map<string, Set<string>> = new Map();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  /**
   * Handle new WebSocket connections
   */
  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Get token from handshake auth or query
      const token =
        client.handshake.auth?.token ||
        client.handshake.query?.token;

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.disconnect();
        return;
      }

      // Verify JWT token
      const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
      const payload = this.jwtService.verify(token as string, { secret });
      const userId = payload.sub;

      // Store userId on socket
      client.userId = userId;

      // Add socket to user's room
      client.join(`user:${userId}`);

      // Track connected socket
      if (!this.connectedUsers.has(userId)) {
        this.connectedUsers.set(userId, new Set());
      }
      this.connectedUsers.get(userId)!.add(client.id);

      this.logger.log(`User ${userId} connected via socket ${client.id}`);

      // Send connection confirmation
      client.emit('connected', { userId, socketId: client.id });
    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  /**
   * Handle WebSocket disconnections
   */
  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.userId;

    if (userId) {
      // Remove socket from tracking
      const userSockets = this.connectedUsers.get(userId);
      if (userSockets) {
        userSockets.delete(client.id);
        if (userSockets.size === 0) {
          this.connectedUsers.delete(userId);
        }
      }

      this.logger.log(`User ${userId} disconnected (socket ${client.id})`);
    }
  }

  /**
   * Send notification to a specific user
   */
  sendNotificationToUser(userId: string, notification: Notification) {
    this.server.to(`user:${userId}`).emit('notification', notification);
    this.logger.log(`Sent notification ${notification.id} to user ${userId}`);
  }

  /**
   * Send notification to multiple users
   */
  sendNotificationToUsers(userIds: string[], notification: Notification) {
    userIds.forEach((userId) => {
      this.server.to(`user:${userId}`).emit('notification', notification);
    });
    this.logger.log(
      `Sent notification ${notification.id} to ${userIds.length} users`,
    );
  }

  /**
   * Send unread count update to a user
   */
  sendUnreadCountUpdate(userId: string, unreadCount: number) {
    this.server.to(`user:${userId}`).emit('unreadCount', { unreadCount });
  }

  /**
   * Broadcast to all connected users (for system announcements)
   */
  broadcastToAll(notification: Notification) {
    this.server.emit('notification', notification);
    this.logger.log(`Broadcast notification ${notification.id} to all users`);
  }

  /**
   * Check if a user is currently connected
   */
  isUserConnected(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }

  /**
   * Get count of connected users
   */
  getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  // ==================== Client Events ====================

  /**
   * Handle client requesting their unread count
   */
  @SubscribeMessage('getUnreadCount')
  handleGetUnreadCount(@ConnectedSocket() client: AuthenticatedSocket) {
    // This will be handled by the controller calling the service
    // Just acknowledge the request here
    return { event: 'unreadCountRequest', data: { userId: client.userId } };
  }

  /**
   * Handle client marking notification as read
   */
  @SubscribeMessage('markAsRead')
  handleMarkAsRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { notificationId: string },
  ) {
    return {
      event: 'markAsReadRequest',
      data: { userId: client.userId, notificationId: data.notificationId },
    };
  }
}
