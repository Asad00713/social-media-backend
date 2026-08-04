import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { canvaConnections, CanvaConnection } from '../drizzle/schema/canva.schema';
import { encrypt, decrypt } from '../common/utils/encryption.util';
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
 *
 * Access and refresh tokens are encrypted at rest (AES-256-GCM via
 * `encryption.util`) — the same protection the social-channel tokens get.
 * They are encrypted on every write and decrypted only when handed to an
 * outbound Canva call. `decrypt` tolerates legacy plaintext rows, so existing
 * connections keep working and get re-encrypted on their next refresh.
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
    const accessToken = encrypt(input.accessToken);
    const refreshToken = encrypt(input.refreshToken);

    const [row] = await db
      .insert(canvaConnections)
      .values({
        workspaceId,
        userId,
        canvaUserId: input.canvaUserId,
        displayName: input.displayName,
        accessToken,
        refreshToken,
        tokenExpiresAt,
      })
      .onConflictDoUpdate({
        target: canvaConnections.workspaceId,
        set: {
          canvaUserId: input.canvaUserId,
          displayName: input.displayName,
          accessToken,
          refreshToken,
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
      return decrypt(connection.accessToken);
    }

    this.logger.log(
      `Canva access token expired/expiring for workspace ${workspaceId}, refreshing`,
    );
    const refreshed = await this.canvaService.refreshAccessToken(
      decrypt(connection.refreshToken),
    );

    const tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db
      .update(canvaConnections)
      .set({
        accessToken: encrypt(refreshed.accessToken),
        refreshToken: encrypt(refreshed.refreshToken),
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(canvaConnections.workspaceId, workspaceId));

    return refreshed.accessToken;
  }

  /**
   * Disconnect Canva for a workspace: revoke the tokens at Canva's end, then
   * delete the stored connection. Revocation is best-effort (see
   * `CanvaService.revokeToken`); the local row is deleted regardless so the
   * user is never left with a stale connection they can't clear. Idempotent —
   * returns quietly if nothing is connected.
   */
  async disconnect(workspaceId: string): Promise<void> {
    const connection = await this.getByWorkspace(workspaceId);
    if (!connection) {
      return;
    }

    // Revoking the refresh token invalidates its whole lineage (the access
    // token derived from it), so one call tears the grant down at Canva.
    await this.canvaService.revokeToken(decrypt(connection.refreshToken));

    await db
      .delete(canvaConnections)
      .where(eq(canvaConnections.workspaceId, workspaceId));

    this.logger.log(`Canva connection disconnected for workspace ${workspaceId}`);
  }
}
