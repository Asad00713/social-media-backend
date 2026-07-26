import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { workspace, workspaceInvitation } from 'src/drizzle/schema';
import type { WorkspaceRole } from './role-capabilities';

@Injectable()
export class WorkspaceRoleService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async getRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    const ws = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
    });
    if (!ws) return null;
    if (ws.ownerId === userId) return 'OWNER';

    const inv = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });

    return (inv?.role as WorkspaceRole) ?? null;
  }
}
