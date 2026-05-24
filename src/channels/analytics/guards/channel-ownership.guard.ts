import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';

export interface ChannelLookupRepo {
  findChannel(channelId: number): Promise<{ id: number; workspaceId: string } | null>;
}

export const CHANNEL_LOOKUP_REPO = 'CHANNEL_LOOKUP_REPO';

/**
 * Verifies channel referenced by `:channelId` belongs to workspace `:wsId`.
 * Throws 404 if channel missing, 403 if workspace mismatch.
 *
 * This guard does NOT verify the user has access to the workspace itself —
 * pair with the existing workspace-access guard upstream.
 */
@Injectable()
export class ChannelOwnershipGuard implements CanActivate {
  constructor(@Inject(CHANNEL_LOOKUP_REPO) private readonly repo: ChannelLookupRepo) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ params: { wsId: string; channelId: string } }>();
    const channelId = Number(req.params.channelId);
    if (!Number.isFinite(channelId)) {
      throw new NotFoundException('Channel not found');
    }
    const channel = await this.repo.findChannel(channelId);
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.workspaceId !== req.params.wsId) {
      throw new ForbiddenException('Channel does not belong to this workspace');
    }
    return true;
  }
}

export const ChannelLookupRepoProvider = {
  provide: CHANNEL_LOOKUP_REPO,
  inject: [DRIZZLE],
  useFactory: (db: any): ChannelLookupRepo => ({
    async findChannel(channelId: number) {
      const rows = await db
        .select({ id: socialMediaChannels.id, workspaceId: socialMediaChannels.workspaceId })
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.id, channelId))
        .limit(1);
      return rows[0] ?? null;
    },
  }),
};
