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
import { users } from '../drizzle/schema/users.schema';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { roleCan } from '../workspace-members/role-capabilities';
import type { WorkspaceRole } from '../workspace-members/role-capabilities';
import type {
  TypingClientEvent,
  UserRef,
} from '../inbox/conversations/dto/contract';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import type {
  AnalyticsEventName,
  AnalyticsEventPayloadMap,
} from './types/analytics-events.types';

interface CachedRole {
  role: WorkspaceRole | null;
  expiresAt: number;
}

interface AuthedSocket extends Socket {
  userId?: string;
  email?: string;
  /** Cached `{ id, name, avatarUrl }` for typing relays (looked up once per socket). */
  typingUser?: UserRef;
  /** `<conversationId>:<state>` -> epoch ms the throttle slot was claimed. */
  typingStartAt?: Map<string, number>;
  /** workspaceId -> role (null = no membership) with an expiry, 60 s TTL. */
  typingRoles?: Map<string, CachedRole>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Min gap between relays of the same state for one conversation on one socket. */
const TYPING_MIN_GAP_MS = 1000;
/** How long a socket reuses a looked-up role; revocation window, like the room join. */
const TYPING_ROLE_TTL_MS = 60_000;

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
    private readonly roles: WorkspaceRoleService,
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
    delete socket.typingStartAt;
    delete socket.typingRoles;
    delete socket.typingUser;
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

  /**
   * "Is replying…" presence. Ephemeral: relayed to the other sockets in the
   * workspace room (every member holds at least inbox:view) and never stored.
   * The sender needs inbox:reply. `socket.to` excludes the sender itself.
   */
  @SubscribeMessage('inbox:typing')
  async onInboxTyping(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: TypingClientEvent,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!socket.userId) return { ok: false, reason: 'unauthenticated' };
    if (
      !data ||
      typeof data.workspaceId !== 'string' ||
      !UUID_RE.test(data.workspaceId) ||
      typeof data.conversationId !== 'string' ||
      !UUID_RE.test(data.conversationId) ||
      (data.state !== 'start' && data.state !== 'stop')
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }
    const room = this.workspaceRoom(data.workspaceId);
    if (!socket.rooms.has(room)) return { ok: false, reason: 'not_subscribed' };

    // Claim the throttle slot synchronously, before any await, so concurrent
    // events cannot both pass. Kept on denial too: a denied or failing socket
    // must not be able to hammer the DB either. Dropped events answer ok.
    const now = Date.now();
    const slots = (socket.typingStartAt ??= new Map<string, number>());
    const slotKey = `${data.conversationId}:${data.state}`;
    const last = slots.get(slotKey);
    if (last !== undefined && now - last < TYPING_MIN_GAP_MS) {
      return { ok: true };
    }
    slots.set(slotKey, now);

    const role = await this.roleFor(socket, data.workspaceId, socket.userId);
    if (!role || !roleCan(role, 'inbox:reply')) {
      return { ok: false, reason: 'forbidden' };
    }

    const user = await this.typingUserFor(socket);
    if (!user) return { ok: false, reason: 'unknown_user' };

    socket.to(room).emit('inbox.typing', {
      workspaceId: data.workspaceId,
      conversationId: data.conversationId,
      user,
      state: data.state,
    });
    return { ok: true };
  }

  private async roleFor(
    socket: AuthedSocket,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    const cache = (socket.typingRoles ??= new Map<string, CachedRole>());
    const hit = cache.get(workspaceId);
    if (hit && hit.expiresAt > Date.now()) return hit.role;
    const role = await this.roles.getRole(workspaceId, userId);
    cache.set(workspaceId, {
      role,
      expiresAt: Date.now() + TYPING_ROLE_TTL_MS,
    });
    return role;
  }

  private async typingUserFor(socket: AuthedSocket): Promise<UserRef | null> {
    if (socket.typingUser) return socket.typingUser;
    try {
      const row = await db.query.users.findFirst({
        where: eq(users.id, socket.userId as string),
        columns: { id: true, name: true, avatarUrl: true },
      });
      if (!row) return null;
      socket.typingUser = {
        id: row.id,
        name: row.name ?? '',
        avatarUrl: row.avatarUrl ?? null,
      };
      return socket.typingUser;
    } catch (err) {
      this.logger.error(`Typing user lookup failed: ${(err as Error).message}`);
      return null;
    }
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
