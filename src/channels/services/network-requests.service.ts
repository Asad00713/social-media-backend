import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  NETWORK_REQUEST_NAME_MAX,
  NETWORK_REQUEST_NOTE_MAX,
  networkRequests,
} from '../../drizzle/schema/network-requests.schema';
import type {
  CreateNetworkRequestDto,
  NetworkRequestResponse,
} from '../dto/channel-hub.dto';

/**
 * Requests per person per rolling 24 hours. A person asks for a handful of
 * networks at most; this only stops a script (or a held-down Enter key)
 * filling the table.
 */
export const NETWORK_REQUESTS_PER_DAY = 10;

/** "Request a network" on the Channels page: stored for the product team. */
@Injectable()
export class NetworkRequestsService {
  private readonly logger = new Logger(NetworkRequestsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateNetworkRequestDto,
  ): Promise<NetworkRequestResponse> {
    // The DTO already trims and bounds these; repeated here so a caller
    // that skips validation still cannot store an empty or oversized row.
    const network = (dto.network ?? '').trim();
    const note = dto.note?.trim() ? dto.note.trim() : null;
    if (network.length === 0 || network.length > NETWORK_REQUEST_NAME_MAX) {
      throw new BadRequestException(
        `network must be 1-${NETWORK_REQUEST_NAME_MAX} characters`,
      );
    }
    if (note && note.length > NETWORK_REQUEST_NOTE_MAX) {
      throw new BadRequestException(
        `note must be at most ${NETWORK_REQUEST_NOTE_MAX} characters`,
      );
    }

    await this.assertUnderLimit(userId);

    const [row] = await this.db
      .insert(networkRequests)
      .values({ workspaceId, userId, network, note })
      .returning();
    this.logger.log(
      `Network requested in workspace ${workspaceId}: ${JSON.stringify(network)}`,
    );
    return {
      id: row.id,
      network: row.network,
      note: row.note,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  private async assertUnderLimit(userId: string): Promise<void> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(networkRequests)
      .where(
        and(
          eq(networkRequests.userId, userId),
          gt(networkRequests.createdAt, sql`now() - interval '24 hours'`),
        ),
      );
    if (Number(row?.n ?? 0) >= NETWORK_REQUESTS_PER_DAY) {
      throw new HttpException(
        `You have sent ${NETWORK_REQUESTS_PER_DAY} network requests in the last 24 hours. Try again tomorrow.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
