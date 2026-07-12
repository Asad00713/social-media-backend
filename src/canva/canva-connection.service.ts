import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { canvaConnections, CanvaConnection } from '../drizzle/schema/canva.schema';
import { CanvaService } from './canva.service';

export interface UpsertCanvaConnectionInput {
  canvaUserId?: string;
  displayName?: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Refresh proactively when the stored token is within this many ms of expiring.
const EXPIRY_SKEW_MS = 60 * 1000;

/**
 * Owns the server-side Canva OAuth connection for a workspace.
 *
 * Tokens are read/written here only — controllers never see raw tokens beyond
 * the short-lived access token string handed back by `getValidAccessToken`,
 * which is used immediately for a single outbound Canva API call and never
 * echoed back to the browser (this is the security property the composer
 * integration was built to guarantee, unlike the legacy `src/canva` flow).
 */
@Injectable()
export class CanvaConnectionService {
  private readonly logger = new Logger(CanvaConnectionService.name);

  constructor(private readonly canvaService: CanvaService) {}

  async upsert(
    workspaceId: string,
    userId: string,
    input: UpsertCanvaConnectionInput,
  ): Promise<CanvaConnection> {
    const tokenExpiresAt = new Date(Date.now() + input.expiresIn * 1000);

    const [row] = await db
      .insert(canvaConnections)
      .values({
        workspaceId,
        userId,
        canvaUserId: input.canvaUserId,
        displayName: input.displayName,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        tokenExpiresAt,
      })
      .onConflictDoUpdate({
        target: canvaConnections.workspaceId,
        set: {
          canvaUserId: input.canvaUserId,
          displayName: input.displayName,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          tokenExpiresAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    this.logger.log(`Canva connection upserted for workspace ${workspaceId}`);
    return row;
  }

  async getByWorkspace(workspaceId: string): Promise<CanvaConnection | null> {
    const [row] = await db
      .select()
      .from(canvaConnections)
      .where(eq(canvaConnections.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Returns a valid Canva access token for the workspace, refreshing (and
   * persisting the refreshed tokens) if the stored one is at or near expiry.
   */
  async getValidAccessToken(workspaceId: string): Promise<string> {
    const connection = await this.getByWorkspace(workspaceId);
    if (!connection) {
      throw new NotFoundException('Canva not connected');
    }

    const expiresAt = new Date(connection.tokenExpiresAt).getTime();
    if (expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return connection.accessToken;
    }

    this.logger.log(
      `Canva access token expired/expiring for workspace ${workspaceId}, refreshing`,
    );
    const refreshed = await this.canvaService.refreshAccessToken(
      connection.refreshToken,
    );

    const tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db
      .update(canvaConnections)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(canvaConnections.workspaceId, workspaceId));

    return refreshed.accessToken;
  }
}
