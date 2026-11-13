import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import type { ChannelResponseDto } from '../dto/channel.dto';
import type { UpdateChannelSettingsDto } from '../dto/channel-hub.dto';
import { toChannelResponse } from '../lib/channel-response';
import { loadPeople } from '../lib/people';

/**
 * The channel page's Settings tab: the team's nickname for a channel and
 * its workspace-wide sidebar pin. Nothing else on the row is touched, so a
 * reconnect (which rewrites account_name) never undoes a rename.
 */
@Injectable()
export class ChannelSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async update(
    workspaceId: string,
    channelId: number,
    dto: UpdateChannelSettingsDto,
  ): Promise<ChannelResponseDto> {
    const set: Partial<typeof socialMediaChannels.$inferInsert> = {};
    // undefined = leave as it is; null = clear (the DTO has trimmed it).
    if (dto.nickname !== undefined) set.nickname = dto.nickname;
    if (dto.showInSidebar !== undefined) set.showInSidebar = dto.showInSidebar;

    const where = and(
      eq(socialMediaChannels.id, channelId),
      eq(socialMediaChannels.workspaceId, workspaceId),
    );
    const [row] =
      Object.keys(set).length > 0
        ? await this.db
            .update(socialMediaChannels)
            .set({ ...set, updatedAt: new Date() })
            .where(where)
            .returning()
        : await this.db.select().from(socialMediaChannels).where(where);
    // A channel of another workspace is "not found", never "forbidden".
    if (!row) throw new NotFoundException('Channel not found');

    const people = await loadPeople(this.db, [
      row.connectedByUserId,
      row.pausedByUserId,
    ]);
    return toChannelResponse(row, people);
  }
}
