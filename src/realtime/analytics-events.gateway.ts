import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import type {
  AnalyticsEventName,
  AnalyticsEventPayloadMap,
} from './types/analytics-events.types';

interface AuthedSocket extends Socket {
  userId?: string;
  email?: string;
}

@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class AnalyticsEventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AnalyticsEventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(socket: AuthedSocket): Promise<void> {
    try {
      const token = this.extractToken(socket);
      if (!token) {
        this.logger.warn(
          `Socket ${socket.id} connecting without token, disconnecting`,
        );
        socket.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });

      socket.userId = payload.sub ?? payload.userId;
      socket.email = payload.email;
      this.logger.log(
        `Socket ${socket.id} connected for user ${socket.userId}`,
      );
    } catch (err) {
      this.logger.warn(
        `Socket ${socket.id} auth failed: ${(err as Error).message}`,
      );
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: AuthedSocket): void {
    this.logger.log(
      `Socket ${socket.id} disconnected (user ${socket.userId ?? 'unknown'})`,
    );
  }

  @SubscribeMessage('subscribe:workspace')
  async onSubscribeWorkspace(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { workspaceId: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!socket.userId) return { ok: false, reason: 'unauthenticated' };
    if (!data?.workspaceId)
      return { ok: false, reason: 'missing_workspace_id' };

    const hasAccess = await this.userHasWorkspaceAccess(
      data.workspaceId,
      socket.userId,
    );
    if (!hasAccess) {
      this.logger.warn(
        `Socket ${socket.id} (user ${socket.userId}) denied access to workspace ${data.workspaceId}`,
      );
      return { ok: false, reason: 'forbidden' };
    }

    await socket.join(this.workspaceRoom(data.workspaceId));
    this.logger.log(
      `Socket ${socket.id} (user ${socket.userId}) joined workspace ${data.workspaceId}`,
    );
    return { ok: true };
  }

  private async userHasWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const owned = await db.query.workspace.findFirst({
        where: and(
          eq(workspace.id, workspaceId),
          eq(workspace.ownerId, userId),
        ),
        columns: { id: true },
      });
      if (owned) return true;

      const member = await db.query.workspaceInvitation.findFirst({
        where: and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.userId, userId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
        columns: { id: true },
      });
      return !!member;
    } catch (err) {
      this.logger.error(
        `Workspace access check failed for user=${userId} ws=${workspaceId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  @SubscribeMessage('unsubscribe:workspace')
  async onUnsubscribeWorkspace(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { workspaceId: string },
  ): Promise<{ ok: boolean }> {
    await socket.leave(this.workspaceRoom(data.workspaceId));
    return { ok: true };
  }

  /** Public emit helpers — called by AnalyticsEventEmitter service */
  emitToWorkspace<K extends AnalyticsEventName>(
    workspaceId: string,
    eventName: K,
    payload: AnalyticsEventPayloadMap[K],
  ): void {
    this.server.to(this.workspaceRoom(workspaceId)).emit(eventName, payload);
  }

  private workspaceRoom(workspaceId: string): string {
    return `workspace:${workspaceId}`;
  }

  private extractToken(socket: Socket): string | null {
    const fromAuth = socket.handshake.auth?.token;
    if (fromAuth) return fromAuth as string;
    const fromHeader = socket.handshake.headers?.authorization;
    if (typeof fromHeader === 'string' && fromHeader.startsWith('Bearer ')) {
      return fromHeader.slice(7);
    }
    const fromQuery = socket.handshake.query?.token;
    if (typeof fromQuery === 'string') return fromQuery;
    return null;
  }
}
